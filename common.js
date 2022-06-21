const BN = require('bignumber.js');
const R = require('ramda');
const uuid = require('uuid');
const uuidValidation = require('uuid-validate');

const getTimeFromTimeuuid = (uuid_str) => {
  const uuid_arr = uuid_str.split('-');
  const time_str = [
    uuid_arr[2].substring(1),
    uuid_arr[1],
    uuid_arr[0],
  ].join('');

  return Math.floor(parseInt(time_str, 16) / 100000);
};

const isUuid = (s, version = 4) => uuidValidation(s, version);

const bn = (x) => new BN(x);

const flattenObject = (obj) => {
  const toReturn = {};
  const keys = Object.keys(obj);
  keys.forEach((key) => {
    if (typeof (obj[key]) === 'object' && obj[key] !== null) {
      const flatObject = flattenObject(obj[key]);
      const flatObjectKeys = Object.keys(flatObject);
      flatObjectKeys.forEach((flatObjectKey) => {
        toReturn[`${key}.${flatObjectKey}`] = flatObject[flatObjectKey];
      });
    } else {
      toReturn[key] = obj[key];
    }
  });
  return toReturn;
};

const unflatten = (flatObject) => {
  const keys = Object.keys(flatObject);
  return keys.reduce((result, key) => R.assocPath(key.split('.'), flatObject[key], result), {});
};

module.exports = {
  R, BN, bn, uuid, uuidValidation, getTimeFromTimeuuid, isUuid, flattenObject, unflatten,
};
