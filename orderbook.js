const EventEmitter = require('events');
const crc32 = require('crc-32');
const { bn, R } = require('./common');

const ascSort = (a, b) => {
  if (bn(a.level).isGreaterThan(b.level)) return -1;
  if (bn(a.level).isLessThan(b.level)) return 1;
  return 0;
};

const ascSortTrades = (a, b) => {
  if (bn(a.time).isGreaterThan(b.time)) return 1;
  if (bn(a.time).isLessThan(b.time)) return -1;
  return 0;
};

const levelExists = (orders, alevel) => orders.filter(({ level }) => level !== alevel).length !== orders.length;

const crcChecksumNormalize = (n) => {
  const removedDot = n.toString().replace('.', '');

  return `${parseInt(removedDot, 10)}`;
};

class Orderbook extends EventEmitter {
  constructor(depth, decimals = 0, distanceBetweenUpdates = 2000) {
    super();
    this.depth = depth;
    this.decimals = decimals;
    this.asks = [];
    this.bids = [];
    this.bookState = false;
    this.lastUpdateSent = new Date();
    this.updatesCountSinceLastSent = 0;
    this.distanceBetweenUpdates = distanceBetweenUpdates;
  }

  getAsksStr() {
    return R.take(10, this.asks).reduce((c, { level, volume }) => {
      const normalizedLevel = crcChecksumNormalize(level);
      const normalizedVolume = crcChecksumNormalize(volume);
      return `${c}${normalizedLevel}${normalizedVolume}`;
    }, '');
  }

  getBidsStr() {
    return R.take(10, this.bids).reduce((c, { level, volume }) => {
      const normalizedLevel = crcChecksumNormalize(level);
      const normalizedVolume = crcChecksumNormalize(volume);
      return `${c}${normalizedLevel}${normalizedVolume}`;
    }, '');
  }

  checkCRC(expected) {
    const asksStr = this.getAsksStr();
    const bidsStr = this.getBidsStr();
    const c = `${asksStr}${bidsStr}`;
    const calculated = parseInt(crc32.str(c), 10) >>> 0;
    return parseInt(expected, 10) === parseInt(calculated, 10);
  }

  init(info) {
    const { as, bs, c } = info;
    if (as) {
      this.asks = R.reverse(R.sort(ascSort, as.map(([level, volume, timestamp]) => ({ level, volume, timestamp }))));
    }
    if (bs) {
      this.bids = bs.map(([level, volume, timestamp]) => ({ level, volume, timestamp }));
    }
    this.validationCheckpoint(c);
  }

  track(info) {
    const { a, b, c } = info;
    const [level1AskRaw] = R.take(1, this.asks);
    const [level1BidRaw] = R.take(1, this.bids);
    const level1Ask = JSON.parse(JSON.stringify(level1AskRaw));
    const level1Bid = JSON.parse(JSON.stringify(level1BidRaw));
    if (a) {
      this.updatesCountSinceLastSent += a.length;
      this.asks = R.take(this.depth, R.reverse(R.sort(ascSort, a.reduce((currentLevels, [updateLevel, volume, timestamp, ut]) => {
        if (bn(volume).isZero()) {
          // remove
          return currentLevels.filter(({ level }) => level !== updateLevel);
        }
        if (levelExists(currentLevels, updateLevel)) {
        // update
          return currentLevels.reduce((ls, l) => {
            if (l.level === updateLevel) {
              return ls.concat([{ level: updateLevel, volume, timestamp }]);
            }
            return ls.concat([l]);
          }, []);
        }
        return currentLevels.concat([{ level: updateLevel, volume, timestamp }]);
      }, this.asks))));
    }
    if (b) {
      this.updatesCountSinceLastSent += b.length;
      this.bids = R.take(this.depth, R.sort(ascSort, b.reduce((currentLevels, [updateLevel, volume, timestamp, ut]) => {
        if (bn(volume).isZero()) {
          // remove
          return currentLevels.filter(({ level }) => level !== updateLevel);
        }
        // update
        if (levelExists(currentLevels, updateLevel)) {
          return currentLevels.reduce((ls, l) => {
            if (l.level === updateLevel) {
              return ls.concat([{ level: updateLevel, volume, timestamp }]);
            }
            return ls.concat([l]);
          }, []);
        }
        return currentLevels.concat([{ level: updateLevel, volume, timestamp }]);
      }, this.bids)));
    }
    if (this.validationCheckpoint(c)) {
      if (level1Ask && level1Ask.level !== this.asks[0].level) {
        this.emit('first-level-change', 'ask', this.asks[0], level1Ask);
      } else {

      }
      if (level1Bid && level1Bid.level !== this.bids[0].level) {
        this.emit('first-level-change', 'bid', this.bids[0], level1Bid);
      } else {

      }
      const now = new Date();
      if (now.getTime() - this.lastUpdateSent.getTime() > this.distanceBetweenUpdates) {
        this.lastUpdateSent = new Date();
        this.emit('update', {
          bids: this.bids,
          asks: this.asks,
          counts: this.updatesCountSinceLastSent,
          time: this.lastUpdateSent.getTime(),
        });
        this.updatesCountSinceLastSent = 0;
      } else {
        this.updatesCountSinceLastSent += 1;
      }
    }
  }

  validationCheckpoint(c) {
    if (c) {
      if (!this.checkCRC(c)) {
        this.bookState = false;
        this.emit('invalid-book');
      } else {
        this.bookState = true;
      }
    }
    return this.bookState;
  }

  full() {
    if (!this.bookState) {
      return {};
    }
    return {
      asks: this.asks,
      bids: this.bids,
    };
  }

  compressFull(priceFlatten = (p, decimals = 2) => bn(p).toFixed(decimals)) {
    const full = this.full();

    return {
      asks: (full.asks || []).reduce((r, { level, volume }) => {
        const fp = priceFlatten(level);

        if (r.length === 0) {
          return r.concat([{ level: fp, price: level, volume: parseFloat(volume) }]);
        }
        const last = r[r.length - 1];
        if (last.level === fp) {
          r[r.length - 1].volume += parseFloat(volume);
          return [].concat(r);
        }
        return r.concat([{ level: fp, price: level, volume: parseFloat(volume) }]);
      }, []),
      bids: (full.bids || []).reduce((r, { level, volume }) => {
        const fp = priceFlatten(level);
        if (r.length === 0) {
          return r.concat([{ level: fp, price: level, volume: parseFloat(volume) }]);
        }
        const last = r[r.length - 1];
        if (last.level === fp) {
          r[r.length - 1].volume += parseFloat(volume);
          return [].concat(r);
        }
        return r.concat([{ level: fp, price: level, volume: parseFloat(volume) }]);
      }, []),
    };
  }

  best() {
    if (!this.bookState) {
      return {};
    }
    return {
      ask: this.asks[0],
      bid: this.bids[0],
    };
  }
}

module.exports = Orderbook;
