const Kraken = require('.');

const kraken = new Kraken({ debug: true, pairs: ['ETH/USD', 'MATIC/USD', 'FTM/USD'] });

kraken.on('orderbook-change', ({ pair, bids, asks }) => {
  console.log(`${pair} ask: ${asks[0].level} bid: ${bids[0].level}`);
});
