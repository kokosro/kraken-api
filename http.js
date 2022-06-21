const got = require('got');
const qs = require('qs');
const sign = require('./sign');

const defaultOptions = {
  agent: 'Kraken Wrapper',
  timeout: 5000,
  version: 0,
  httpUrl: 'https://api.kraken.com',
  nonceWeight: 1000,
};

class Http {
  constructor(opts = {}) {
    this.agent = opts.agent || defaultOptions.agent;
    this.timeout = opts.timeout || defaultOptions.timeout;
    this.version = opts.version || defaultOptions.version;
    this.httpUrl = opts.httpUrl || defaultOptions.httpUrl;
    this.auth = opts.auth;

    this.nonceWeight = opts.nonceWeight || defaultOptions.nonceWeight;
  }

  nextNonce() {
    return Date.now() * this.nonceWeight;
  }

  sign(path, params = {}) {
    const nonce = params.nonce || this.nextNonce();
    const data = { nonce, ...params };

    return { signature: sign(path, data, this.auth.secret, data.nonce), nonce };
  }

  async request(url, params, opts = {}) {
    const options = {
      method: 'POST',
      body: qs.stringify(params),
      timeout: this.timeout,
      ...opts,
      headers: {
        ...(opts.headers || {}),
        'User-Agent': this.agent,
      },
    };

    try {
      const { body } = await got(url, options);

      const response = JSON.parse(body);
      if (response.error && response.error.length) {
        return null;
      }
      if (response.result) {
        return response.result;
      }
      return response;
    } catch (e) {
      return null;
    }
  }

  getPath(method, isPublic = false) {
    return `/${this.version}/${isPublic ? 'public' : 'private'}/${method}`;
  }

  getUrl(method, isPublic = false) {
    return `${this.httpUrl}${this.getPath(method, isPublic)}`;
  }

  publicMethod(method, params = {}) {
    const url = this.getUrl(method, true);
    return this.request(url, params);
  }

  privateMethod(method, params = {}) {
    const path = this.getPath(method, false);
    const url = this.getUrl(method, false);
    const { key } = this.auth;

    const { signature, nonce } = this.sign(path, params);

    const headers = {
      'API-Key': key,
      'API-Sign': signature,
    };
    return this.request(url, { ...params, nonce }, { headers });
  }
}

module.exports = Http;
