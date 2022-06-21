# @kokosro/kraken-api

Compatible with [Kraken API Websockets 1.7.0](https://docs.kraken.com/websockets/)

## Configure

```javascript

const config = {
      credentials: { secret , key },
      pairs: [ ... ], // list of pairs to listen
      depth: 25, // orderbook depth
      ordersRef: 0, // orders will be open with the reference
};

```

## Initialize

```javascript
const Kraken = require('@kokosro/kraken-api');
const kraken = new Kraken(config);

```

## Events emitted

- `orderbook-change` { pair, bids, asks, time }
- `first-level-price-change` { pair, side, current, previous }
- `public-trade` { pair, price, volume, side, orderType  }
- `own-trade` trade
- `order-found` orderId, orderInfo
- `order-change` orderId, orderInfo
- `order-status` orderId, orderInfo



