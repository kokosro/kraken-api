const Kraken = require('.');

const kraken = new Kraken({
  debug: true,
  log: console.log,
  pairs: [],
  cancelOrdersOnProcessExit: true,
});

kraken.on('ready', () => {
  console.log('INITIATED');
});

kraken.init().then(() => {
  kraken.on('orderbook-change', ({ pair, bids, asks }) => {
    console.log(`${pair} ask: ${asks[0].level} bid: ${bids[0].level}`);
  });
  setTimeout(() => {
    kraken.initPair('ETH/EUR');
  }, 1000);
}).catch(console.error);
