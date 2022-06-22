const Websocket = require('ws');
const EventEmitter = require('events');
const { bn, R, uuid } = require('./common');
const Http = require('./http');
const Orderbook = require('./orderbook');
const config = require('./config');

class Kraken extends EventEmitter {
  constructor({
    credentials = null,
    pairs = [],
    depth = 25,
    log = null,
    pingPongInterval = 15000,
    ordersRef = 0,
    orderbookUpdateDistance = 5000,
    decimals = 0,
    debug = false,
    autoConnect = false,
    cancelOrdersOnProcessExit = false,
  }) {
    super();
    this.token = null;
    this.credentials = credentials;
    this.init = this.init.bind(this);
    this.pairs = pairs;
    this.depth = depth;
    this.orderbooks = {};
    this.pingPongInterval = pingPongInterval;
    this._log = log;
    this.decimals = decimals;
    this.orderbookUpdateDistance = orderbookUpdateDistance;
    this.http = new Http({ auth: this.credentials, agent: 'Kraken Wrapper' });
    this.bests = this.bests.bind(this);
    this.cached = {};
    this.initOrderbooks = this.initOrderbooks.bind(this);
    this.privatePingTimer = 0;
    this.publicPingTimer = 0;
    this.lastPrivatePong = new Date();
    this.lastPublicPong = new Date();
    this.checkInitTimer = 0;
    this.lastPublicHeartbeat = 0;
    this.lastPrivateHeartbeat = 0;
    this.okSince = Date.now();
    this.orders = {};
    this.trades = {};
    this.ordersRef = ordersRef;
    this.pendingOrdersByReqId = {};
    this.pendingCancelByReqId = {};
    this.private_event_openOrders = this.private_event_openOrders.bind(this);
    this.gotFirstOwnTrades = false;
    this.debug = debug;
    this.initiated = {
      public: false,
      private: false,
      markets: false,
      assets: false,
    };
    if (!this.credentials) {
      delete this.initiated.private;
    }
    this.initEmitted = false;
    this.panic = 0;
    if (cancelOrdersOnProcessExit) {
      this.attachForceCancelOnProcessExit();
    }

    if (autoConnect) {
      setImmediate(this.init.bind(this));
    }
  }

  async onSIGINT() {
    this.panic += 1;
    this.log(`Caught interrupt signal (${this.panic} Panic abort at 9 tries)`);
    if (this.panic >= 9) {
      process.exit();
    }
    try {
      this.log('cancelling all orders on SIGINT');
      await this.cancelAllOrders();
      this.log('initiating order cancelling on process exit');
    } catch (e) {
      this.log('appears there are no orders available to cancel');
    }
    // setTimeout(() => {
    console.log('BYE');
    process.exit();
    // }, 500);
  }

  attachForceCancelOnProcessExit() {
    process.on('SIGINT', this.onSIGINT.bind(this));
  }

  checkReinit() {
    const now = new Date();
    let reinitFlag = false;
    if (now.getTime() - this.lastPrivatePong.getTime() > this.pingPongInterval * 2) {
      reinitFlag = true;
    }
    if (now.getTime() - this.lastPublicPong.getTime() > this.pingPongInterval * 2) {
      reinitFlag = true;
    }
    if (reinitFlag) {
      this.log(`REINITIALIZING after ${(Math.floor((now.getTime() - this.okSince) / 1000))} seconds of OK connection`, {}, 'LOG', '\n', true);
      this.log('removing orderbook listeners', {}, 'LOG', '\n', true);
      Object.entries(this.orderbooks).forEach(([pair, book]) => {
        this.log(`removing orderbook listeners for ${pair}`, {}, 'LOG', '\n', true);
        book.off('invalid-book', this.orderbookInvalidListener(pair).bind(this));
        book.off('first-level-change', this.orderbookLevelChangeListener(pair).bind(this));
        book.off('update', this.orderbookUpdateListener(pair).bind(this));
      });
      this.log('nulling orderbooks', {}, 'LOG', '\n', true);
      this.orderbooks = null;
      this.log('clearing timeouts', {}, 'LOG', '\n', true);
      clearTimeout(this.privatePingTimer);
      clearTimeout(this.publicPingTimer);
      try {
        this.log('closing publicWs', {}, 'LOG', '\n', true);
        this.publicWs.close();
        this.log('publicWs closed', {}, 'LOG', '\n', true);
        this.publicWs = null;
      } catch (e) {
        this.logError(e);
      }
      this.publicWs = null;
      try {
        this.log('closing privateWs', {}, 'LOG', '\n', true);
        this.privateWs.close();
        this.log('privateWs closed', {}, 'LOG', '\n', true);
      } catch (e) {
        this.logError(e);
      }
      this.privateWs = null;
      process.nextTick(this.init.bind(this));
      this.okSince = Date.now();
      return;
    }
    clearTimeout(this.checkInitTimer);
    this.checkInitTimer = setTimeout(this.checkReinit.bind(this), this.pingPongInterval * 1.5);
  }

  orderbook(pair) {
    return this.orderbooks[pair];
  }

  createOrderbook(pair) {
    const orderbook = new Orderbook(this.depth, this.orderbookUpdateDistance);
    orderbook.on('invalid-book', this.orderbookInvalidListener(pair).bind(this));
    orderbook.on('first-level-change', this.orderbookLevelChangeListener(pair).bind(this));
    this.log(`attaching orderbook update for ${pair}`, {}, 'LOG', '\n', true);
    orderbook.on('update', this.orderbookUpdateListener(pair).bind(this));
    return orderbook;
  }

  orderbookUpdateListener(pair) {
    const listener = ({
      bids, asks, counts, time,
    }) => {
      // (p) => bn(p).toFixed(this.decimals)
      const obc = this.orderbooks[pair].full();
      this.emit('orderbook-change', {
        pair, bids: obc.bids, asks: obc.asks, counts, time,
      });
    };
    return listener.bind(this);
  }

  orderbookInvalidListener(pair) {
    const listener = () => {
      try {
        // this.emit(`${pair}#invalid-book`);
        this.log(`\n\n\n\n\n\n\n\n\n\n\n\n\n\nINVALID ${pair} BOOK. unsubscribing\n\n\n\n\n\n\n\n\n\n`);
        this.publicUnsubscribe({ name: 'book', depth: this.depth }, [pair]);
      } catch (e) {
        this.log(e);
      }
    };
    return listener.bind(this);
  }

  orderbookLevelChangeListener(pair) {
    const listener = (side, current, previous) => {
      // this.x = (this.x || 0) + 1;
      this.emit('first-level-price-change', {
        pair, side, current, previous,
      });
    };
    return listener.bind(this);
  }

  initOrderbooks(depth) {
    const orderbooks = this.pairs.reduce((r, pair) => ({
      ...r,
      [pair]: this.createOrderbook(pair),
    }), {});

    this.orderbooks = orderbooks;
  }

  initOrderbook(pair) {
    this.orderbooks[pair] = this.createOrderbook(pair);
  }

  initPair(pair) {
    if (!this.marketPairs[pair]) {
      throw new Error(`unknown pair ${pair}`);
    }
    if (this.orderbooks[pair]) {
      return;
    }
    if (this.pairs.includes(pair)) {
      this.pairs.push(pair);
    }
    this.initOrderbook(pair);
    this.publicSubscribePairBook(pair);
    this.publicSubscribePairTrades(pair);
  }

  log(message, obj = {}, level = 'LOG', end = '\n', _debug = this.debug) {
    if (this._log) {
      if (this.debug || _debug) {
        this._log(message, obj, level, end);
      }
    } else if (this.debug) {
      const m = `[${(new Date()).toISOString()}][${level}] ${message} ${JSON.stringify(obj)}${end}`;
      // process.stdout.write();
      console.log(m);
    }
  }

  logError(message, error = null) {
    if (!error) {
      if (message && message.message) {
        this.log(message.message, {}, 'ERROR');
      } else {
        this.log(message, {}, 'ERROR');
      }
    } else {
      this.log(message, { error: error.message || error }, 'error');
    }
  }

  async marketInfoInit() {
    this.log('initializing market information');
    const rawassets = await this.http.publicMethod('Assets');
    const rawpairs = await this.http.publicMethod('AssetPairs');
    this.initMarketAssets(rawassets);
    this.initMarketPairs(rawpairs);
    this.initiated.markets = true;
    this.initiated.assets = true;
  }

  initMarketAssets(rawassets) {
    if (!rawassets) return;
    this.marketAssets = Object.entries(rawassets).reduce((rinfo, [xasset, info]) => ({
      ...rinfo,
      [info.altname]: { ...info, key: xasset },
    }), {});
    this.translate = {
      ...(this.translate || {}),
      ...Object.values(this.marketAssets).reduce((r, v) => ({ ...r, [v.key]: v.altname, [v.altname]: v.key }), {}),
    };
  }

  initMarketPairs(rawpairs) {
    if (!rawpairs) return;
    this.marketPairs = Object.entries(rawpairs).reduce((rinfo, [xpair, info]) => ({
      ...rinfo,
      [info.wsname]: {
        ...info,
        key: xpair,
        quote: this.translate[info.quote] || info.quote,
        base: this.translate[info.base] || info.base,
      },
    }), {});
    this.translate = {
      ...(this.translate || {}),
      ...Object.values(this.marketPairs).reduce((r, v) => ({ ...r, [v.key]: v.wsname, [v.wsname]: v.key }), {}),
    };
  }

  isInitiating() {
    return Object.values(this.initiated).reduce((r, v) => r || v, false);
  }

  isInitiated(initiated = this.initiated) {
    return Object.values(initiated).reduce((r, v) => r && v, true);
  }

  async init(force = false) {
    if (!force && this.isInitiating()) {
      return;
    }
    await this.marketInfoInit();

    this.log('initializing orderbooks', {}, 'LOG', '\n', true);

    if (this.credentials) {
      this.log('getting websocket token');

      const tokenInit = await this.http.privateMethod('GetWebSocketsToken', {}, this.credentials);
      if (!tokenInit || !tokenInit.token) {
        this.logError('Unable to get websocket token');
        process.exit(1);
        return;
      }

      this.log('Received websocket token', {}, 'LOG', '\n', true);
      this.token = tokenInit.token;
    }
    this.log('starting sockets', {}, 'LOG', '\n', true);
    this.startSocket();
    this.log('initializing checkReinit', {}, 'LOG', '\n', true);
    clearTimeout(this.checkInitTimer);
    this.checkInitTimer = setTimeout(this.checkReinit.bind(this), this.pingPongInterval * 1.5);
    if (this.pairs.length > 0) {
      this.initOrderbooks();
    }
  }

  hasToken() {
    return !!this.token;
  }

  isPublicStarted() {

  }

  isPrivateStarted() {

  }

  startSocket() {
    this.log('Starting socket', {}, 'LOG', '\n', true);
    this.startPublicSocket();
    if (this.credentials) {
      this.startPrivateSocket();
    }
  }

  startPublicSocket() {
    this.publicWs = new Websocket(config.publicWs);
    this.publicWs.on('error', this.publicWsError.bind(this));
    this.publicWs.on('open', this.publicWsOpen.bind(this));
    this.publicWs.on('message', this.publicWsMessageProcessor.bind(this));
    this.publicWs.on('pong', () => null);
  }

  startPrivateSocket() {
    this.privateWs = new Websocket(config.privateWs);
    this.privateWs.on('error', this.privateWsError.bind(this));
    this.privateWs.on('open', this.privateWsOpen.bind(this));
    this.privateWs.on('message', this.privateWsMessageProcessor.bind(this));
    this.privateWs.on('pong', () => null);
  }

  nextReqId() {
    if (!this._reqid) {
      this._reqid = Date.now() * 1000;
    }
    this._reqid += 1;
    return this._reqid + 0;
  }

  // ------------------public-------------------

  publicWsError(error) {
    this.log('public socket error', { message: (error || {}).message });
  }

  publicSubscribePairBook(pair) {
    this.publicSubscribe({
      name: 'book',
      depth: this.depth,
    }, [pair]);
  }

  publicSubscribePairTrades(pair) {
    this.publicSubscribe({
      name: 'trade',

    }, [pair]);
  }

  publicWsOpen(x) {
    this.log('public socket open', { x: x || 'jm' }, 'LOG', '\n', true);
    for (let i = 0; i < this.pairs.length; i++) {
      this.publicSubscribePairBook(this.pairs[i]);
      this.publicSubscribePairTrades(this.pairs[i]);
    }

    this.sendDelayedPublicPing();
    this.initiated.public = true;
    this.emitOnInit();
  }

  emitOnInit(initiated = this.initiated) {
    if (!this.initEmitted) {
      if (this.isInitiated(initiated)) {
        this.initEmitted = true;
        this.emit('ready');
      }
    }
  }

  public_event_systemStatus(info) {
    this.log(`systemStatus received ${info.status}`);
  }

  public_event_book(info, pair, info2 = null) {
    if (!this.orderbooks[pair]) {
      this.orderbooks[pair] = new Orderbook(this.depth, this.decimals);
    }
    if (info.as || info.bs) {
      this.orderbooks[pair].init(info);
    }
    if (info.a || info.b) {
      this.orderbooks[pair].track(info);
    }
    if (info2) {
      if (info2.as || info2.bs) {
        this.orderbooks[pair].init(info2);
      }
      if (info2.a || info2.b) {
        this.orderbooks[pair].track(info2);
      }
    }
  }

  public_event_subscriptionStatus(message) {
    const { status, pair, subscription: { name } } = message;
    if (status === 'unsubscribed' && name === 'book') {
      this.orderbooks[pair] = this.createOrderbook(pair);
      this.log(`resubscribing to book ${pair} ${this.depth}`, {}, 'LOG', '\n', true);
      this.publicSubscribe({ name: 'book', depth: this.depth }, [pair]);
    } else {

    }
  }

  public_event_pong(message) {
    //    this.log('public pong received', message);
    this.lastPublicPong = new Date();
    this.sendDelayedPublicPing();
  }

  public_event_heartbeat(message) {
    // this.sendDelayedPublicPing();
    if (Math.floor(this.lastPulicHeartbeat / 1000) !== Math.floor(Date.now() / 1000)) {
      //      this.log('public received heartbeat', { message, now: Date.now() });
      this.lastPublicHeartbeat = Date.now();
      process.nextTick(this.publicPing.bind(this));
    }
  }

  public_event_trade(trades, pair) {
    trades.forEach(([price, volume, time, side, orderType]) => {
      this.emit('public-trade', {
        pair,
        price,
        volume,
        side: side === 'b' ? 'buy' : 'sell',
        orderType: orderType === 'l' ? 'limit' : 'market',
      });
    });
  }

  publicWsMessageProcessor(m) {
    try {
      const message = JSON.parse(m);

      if (Array.isArray(message)) {
        const [channel, result, result2] = message;
        const [event, pair] = R.takeLast(2, message);
        if (!event) return this.log('unknown message event type', message);
        this.lastPublicHeartbeat = Date.now();
        try {
          const [eventName, eventOther] = event.split('-');

          if (this[`public_event_${eventName}`]) {
            if (result2 === event) {
              this[`public_event_${eventName}`](result, pair);
            } else {
              this[`public_event_${eventName}`](result, pair, result2);
            }
          } else {

          }
        } catch (e) {
          // this.log(`oops ${event}`, {
          //  event, message, result, channel,
          // });
          this.logError(e);
        }
      } else if (typeof (message) === 'object' && message) {
        try {
          const { event, reqid } = message;
          this.log(`public ${event} received`, { message }, 'LOG', '\n', false);
          if (this[`public_event_${event}`]) {
            this[`public_event_${event}`](message);
          } else {

          }
        } catch (e) {
          //          this.log(`oops ${m}`, {
          //            message,
          //          });
          this.logError(e);
        }
      }
    } catch (e) {
      this.logError(e);
    }
    return null;
  }

  publicWsSend(o) {
    const m = {
      ...o,
    };
    if (!o.reqid) {
      m.reqid = this.nextReqId();
    }
    if (this.publicWs && this.publicWs.readyState === Websocket.OPEN) {
      this.log('public sending', m, 'LOG', '\n', false);
      this.publicWs.send(JSON.stringify(m));
    }
  }

  publicSubscribe(subscription, pair = null) {
    const acceptedNames = ['ticker', 'ohlc', 'trade', 'book', 'spread'];
    if (!acceptedNames.includes(subscription.name)) return;
    this.log('subscribing to public', { subscription, pair }, 'LOG', '\n', false);
    const m = {
      event: 'subscribe',
      pair,
      subscription,
    };
    this.publicWsSend(m);
  }

  publicUnsubscribe(subscription, pair = null) {
    const m = {
      event: 'unsubscribe',
      pair,
      subscription,
    };
    this.publicWsSend(m);
  }

  publicPing() {
    clearTimeout(this.publicPingTimer);
    //    this.log('sending public ping');
    if (this.publicWs && this.publicWs.readyState === Websocket.OPEN) {
      this.publicWs.ping();
    }

    this.publicWsSend({ event: 'ping', reqid: this.nextReqId() });
  }

  sendDelayedPublicPing() {
    clearTimeout(this.publicPingTimer);
    this.publicPingTimer = setTimeout(this.publicPing.bind(this), this.pingPongInterval);
  }

  // ------------------private------------------

  privateWsError(error) {
    this.log('private socket error', { message: (error || {}).message });
  }

  privateWsOpen(x) {
    this.log('private socket open', { x }, 'LOG', '\n', true);
    this.privateSubscribe({ name: 'ownTrades' });
    this.privateSubscribe({ name: 'openOrders' });
    this.sendDelayedPrivatePing();
    this.initiated.private = true;
    this.emitOnInit(this.initiated);
  }

  private_event_pong(message) {
  //  this.log('private pong received', message);
    this.lastPrivatePong = new Date();
    this.sendDelayedPrivatePing();
  }

  private_event_heartbeat(message) {
    //    this.sendDelayedPrivatePing();
    if (Math.floor(this.lastPrivateHeartbeat / 1000) !== Math.floor(Date.now() / 1000)) {
      this.lastPrivateHeartbeat = Date.now();
      //      this.log('private received heartbeat', { message, now: Date.now() });
      process.nextTick(this.privatePing.bind(this));
    }
  }

  privatePing() {
    //    this.log('sending private ping');
    clearTimeout(this.privatePingTimer);
    if (this.privateWs && this.privateWs.readyState === Websocket.OPEN) {
      this.privateWs.ping();
    }
    this.privateWsSend({ event: 'ping', reqid: this.nextReqId() });
  }

  sendDelayedPrivatePing() {
    clearTimeout(this.privatePingTimer);
    this.privatePingTimer = setTimeout(this.privatePing.bind(this), this.pingPongInterval);
  }

  private_event_ownTrades(trades) {
    this.log('received ownTrades', {}, 'LOG', '\n', true);
    if (!this.gotFirstOwnTrades) {
      this.log(`received ownTrades ${trades.length}`);
      this.gotFirstOwnTrades = true;
    } else {
      // hm, we don't have the refid here.
      trades.forEach((trade) => Object.values(trade).forEach((t) => this.emit('own-trade', t)));
    }
  }

  private_event_openOrders(orders) {
    this.log('open orders received', {}, 'LOG', '\n', false);
    orders.forEach((order) => {
      this.log(`found order: ${JSON.stringify(order)}`, {}, 'LOG', '\n', false);
    });
    this.orders = orders.reduce((result, orderObject) => ({
      ...result,
      ...(Object.entries(orderObject).reduce((oResult, [orderId, orderInfo]) => {
        if ((orderInfo.userref && `${orderInfo.userref}` === `${this.ordersRef}`)
            || oResult[orderId]) {
	    let status = 'X';
          if (!this.orders[orderId] && orderInfo.userref) {
            this.emit('order-found', orderId, orderInfo);
	    status = 'INIT';
          }
          if (this.orders[orderId]) {
            this.emit('order-change', orderId, {
              ...(oResult[orderId] || {}),
              ...orderInfo,
              status,
            });
          }
          return {
            ...oResult,

            [orderId]: {
              ...(oResult[orderId] || {}),
              ...orderInfo,
            },
          };
        }
        return oResult;
      }, result)),
    }), this.orders || {});
    //    this.log(`received ownOrders ${Object.keys(this.orders).length}`, orders.length === 1 ? { order: orders[0] } : {});
    this.orders = Object.entries(this.orders).reduce(this.cleanOrdersReducer.bind(this), {});
  }

  cleanOrdersReducer(openOrders, [orderId, orderInfo]) {
    const ignoreStatuses = ['closed', 'canceled', 'cancelled'];
    if (!ignoreStatuses.includes(orderInfo.status)) {
      return { ...openOrders, [orderId]: orderInfo };
    }
    this.emit('order-status', orderId, orderInfo);
    return openOrders;
  }

  private_event_addOrderStatus(message) {
    if (!message) return null;
    const { reqid } = message;
    if (!reqid) {
      return this.log('undefined reqid for message', { message }, 'LOG', '\n', true);
    }
    if (!this.pendingOrdersByReqId[reqid]) {
      return this.log('unknown reqid addOrderStatus', { message });
    }
    if (message.status === 'error' || message.errorMessage) {
      //      this.log(`error adding order ${reqid}`, { message });
      this.pendingOrdersByReqId[reqid].reject(message.errorMessage);
    } else if (this.pendingOrdersByReqId[reqid].dryRun) {
      //      this.log('order validation ok', { message });
      this.pendingOrdersByReqId[reqid].resolve(message);
    } else {
      this.log(`order ${message.txid} (${message.status}) posted ${message.descr}`, {}, 'LOG', '\n', true);

      this.orders[message.txid] = {
        status: 'initiated',
        ...(this.orders[message.txid] || {}),
        ...this.pendingOrdersByReqId[reqid].orderInfo,

      };

      this.pendingOrdersByReqId[reqid].resolve({
        [message.txid]: {
          ...this.pendingOrdersByReqId[reqid].orderInfo,
          status: 'initiated',
        },
      });
    }
    delete this.pendingOrdersByReqId[reqid];
    return null;
  }

  private_event_cancelOrderStatus(message) {
    if (!message) return this.log('empty message??');
    if (!message.reqid) return this.log('undefined reqid on cancelOrderStatus');
    const { reqid, status, errorMessage } = message;
    //  this.log('pending cancels', { p: this.pendingCancelByReqId });
    const reqidS = `${reqid}`;
    if (!this.pendingCancelByReqId[reqidS]) {
      return this.log(`unknown reqid ${reqid} cancelOrderStatus`, { message });
    }
    if (status === 'error' || errorMessage) {
      //    this.log('error while cancelling order', { message });
      clearTimeout(this.pendingCancelByReqId[reqidS].timeout);
      this.pendingCancelByReqId[reqidS].reject(message);
    } else {
      //      this.log(`${this.pendingCancelByReqId[reqidS].all ? 'all' : ''}order(s) cancelled `, { txids: this.pendingCancelByReqId[reqidS].txids });
      clearTimeout(this.pendingCancelByReqId[reqidS].timeout);
      this.pendingCancelByReqId[reqidS].resolve(message);
    }
    delete this.pendingCancelByReqId[reqidS];
    return null;
  }

  privateWsMessageProcessor(m) {
    try {
      const message = JSON.parse(m);
      // this.log('private message received', { message });
      if (Array.isArray(message)) {
        let result;
        let event;
        if (message.length === 3) {
          if (message[1] === 'openOrders') {
            event = 'openOrders';
            [result] = R.take(1, message);
          } else {
            [result] = R.take(1, message);

            [, event] = R.takeLast(2, message);
          }
        } else {
          [result] = R.take(1, message);

          [, event] = R.takeLast(2, message);
        }
        if (!event) return this.log('unknown private message event type', message);
        try {
          this.log(`EVENT. event ${event}`);
          if (this[`private_event_${event}`]) {
            this[`private_event_${event}`](result);
          } else {

          }
        } catch (e) {
          //          this.log(`oops ${event}`, {
          //            event, message, result,
          //          });
          this.logError(e);
        }
      } else if (typeof (message) === 'object' && message) {
        try {
          const { event, reqid } = message;
          this.log(`EVENT event ${event}`);
          if (this[`private_event_${event}`]) {
            this[`private_event_${event}`](message);
          } else {
            this.log(`unknown private message ${event}`, message);
          }
        } catch (e) {
          //          this.log(`oops ${m}`, {
          //            message,
          //          });
          this.logError(e);
        }
      }
    } catch (e) {
      this.logError(e);
    }
    return null;
  }

  privateWsSend(o) {
    const m = {
      ...o,
    };
    if (!o.reqid) {
      m.reqid = this.nextReqId();
    }
    if (this.privateWs && this.privateWs.readyState === Websocket.OPEN) {
      if (o.event !== 'ping') {
        //    this.log('private sending', m);
      }
      this.privateWs.send(JSON.stringify(m));
    }
  }

  privateSubscribe(subscription) {
    const m = {
      event: 'subscribe',
      subscription: {
        ...subscription,
        token: this.token,
      },
    };
    this.log(`subscribing to ${JSON.stringify(subscription)}`);
    this.privateWsSend(m);
  }

  async balance(translated = true) {
    const b = await this.http.privateMethod('Balance', {});
    if (!b) return {};
    const dict = this.translate;
    return Object.entries(b).reduce((r, [a, v]) => ({
      ...r,
      [dict[a] || a]: bn(v).toFixed(8),
    }), {});
  }

  async tradeVolume(translated = true) {
    const b = await this.http.privateMethod('TradeVolume', { });
    if (!b) return this.cached.tradeVolume || {};
    b.currency = this.translate[b.currency] || b.currency;
    this.cached.tradeVolume = b;
    return b;
  }

  bests() {
    return this.pairs.reduce((r, pair) => {
      const best = this.orderbooks[pair].best();
      return { ...r, [pair]: best };
    }, {});
  }

  addOrder({
    ordertype = 'limit',
    pair,
    type,
    price,
    volume,
    leverage = null,
    starttm = '0',
    expiretm = `+${24 * 60 * 60}`,
    userref = `${this.ordersRef}`,

  }, dryRun = false) {
    const thePromise = (resolve, reject) => {
      const reqid = this.nextReqId();
      const orderInfo = {
        ordertype,
        pair,
        price,
        type,
        volume,
        starttm,
        expiretm,
      };
      const orderEvent = {
        event: 'addOrder',
        token: this.token,
        userref,
        reqid,
        ...orderInfo,
      };
      this.log(`adding order ${JSON.stringify(orderInfo, null, 2)}`);
      if (dryRun) {
        orderEvent.validate = true;
      }
      if (leverage) {
        orderEvent.leverage = leverage;
      }
      this.pendingOrdersByReqId[reqid] = {
        resolve, reject, orderInfo, dryRun,
      };
      this.privateWsSend(orderEvent);
    };
    return new Promise(thePromise.bind(this));
  }

  pendingCancelByReqIdTimeout(reqid) {
    return () => {
      const reqidS = `${reqid}`;
      if (!this.pendingCancelByReqId[reqidS]) {
        this.log(`unknown reqid ${reqid} cancelOrderStatusTimeout`);
        return;
      }
      this.pendingCancelByReqId[reqidS].reject(new Error(`cancelOrder request ${reqid} timeout`));

      delete this.pendingCancelByReqId[reqidS];
    };
  }

  cancelOrder(...txids) {
    const thePromise = (resolve, reject) => {
      const reqid = this.nextReqId();

      this.pendingCancelByReqId[reqid] = {
        txids,
        resolve,
        reject,
        all: txids.length === 0,
        timeout: setTimeout(this.pendingCancelByReqIdTimeout(reqid).bind(this), 2000),
      };

      const event = { event: 'cancelOrder', token: this.token, reqid };
      this.log(`cancelling orders ${txids.length === 0 ? 'all' : `[${txids.join(', ')}]`} ${JSON.stringify(event, null, 2)}`);
      if (txids.length === 0) {
        event.txid = [`${this.ordersRef}`];
      } else {
        event.txid = txids;
      }
      this.privateWsSend(event);
    };
    return new Promise(thePromise.bind(this));
  }

  cancelAllOrders() {
    this.log('issuing cancell all orders');
    return this.cancelOrder();
  }
}

module.exports = Kraken;
