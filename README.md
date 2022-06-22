# @kokosro/kraken-api

Compatible with [Kraken API Websockets 1.7.0](https://docs.kraken.com/websockets/)

## Configure

```javascript

const config = {
      credentials: { secret , key },
      pairs: [ ... ], // list of pairs to listen
      depth: 25, // orderbook depth
      ordersRef: 0, // orders will be open with the reference
      autoConnect: false // automatically connects to server
      cancelOrdersOnProcessExit: true // defaults to false. issues a cancellAllOrders on SIGINT
      debug
};

```

## Initialize

```javascript
const Kraken = require('@kokosro/kraken-api');
const kraken = new Kraken(config);

kraken.init().then(()=>{
        // websocket connects should be opened
}).catch(console.error);

```

## Init Pair
Pairs can be initiated on instance creation or by using `.initPair(pair)` method

## Create Order
`.addOrder(orderInfo)`
[orderInfo](https://docs.kraken.com/websockets/#message-addOrder)

## known live orders
- `.orders`

## Cancel Order
Cancel a specific orders by providing their order ids
`.cancelOrder(...orderids)`

when no `orderids` are provided it will try and cancel any live orders craeted by the instance `ordersRef`

## Cancel all orders
`.cancelAllOrders()` - will cancel all live orders created by the instance `ordersRef`

## Orderbook
`.orderbook(pair)` - will return the current orderbook of the pair

## Bests
`.bests()` - will return a snapshot of best prices for all pairs

## Events emitted

- `ready`
- `orderbook-change` { pair, bids, asks, time }
- `first-level-price-change` { pair, side, current, previous }
- `public-trade` { pair, price, volume, side, orderType  }
- `own-trade` trade
- `order-found` orderId, orderInfo
- `order-change` orderId, orderInfo
- `order-status` orderId, orderInfo



