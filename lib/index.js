'use strict';

const http2 = require('http2');

const extend = require('extend');
const bourne = require('@hapi/bourne');

function streamText(_stream, _maxSize = 0) {
  return new Promise((_resolve, _reject) => {
    let buffer = Buffer.allocUnsafe(0);

    function cleanup() {
      _stream.off('error', onError);
      _stream.off('data', onData);
      _stream.off('end', onEnd);
    }

    function onError(_error) {
      cleanup();
      return _reject(_error);
    }

    function onData(_chunk) {
      buffer = Buffer.concat([buffer, _chunk]);

      if (_maxSize && buffer.length > _maxSize) {
        cleanup();
        _stream.destroy(new Error('Data length exceeded'));
      }
    }

    function onEnd() {
      cleanup();
      _stream.close(http2.constants.NGHTTP2_NO_ERROR);
      return _resolve(buffer.toString());
    }

    _stream.on('error', onError);
    _stream.on('data', onData);
    _stream.on('end', onEnd);
  });
}

async function streamJSON(_stream, _maxSize = 0) {
  const text = await streamText(_stream, _maxSize);
  return bourne.parse(text);
}

function sessionRequest(_session, _options) {
  return new Promise((_resolve, _reject) => {
    const options = extend(true, {
      headers: {
        [http2.constants.HTTP2_HEADER_METHOD]: 'GET',
        [http2.constants.HTTP2_HEADER_PATH]: '/'
      }
    }, _options);

    const stream = _session.request(options.headers);

    function cleanup() {
      stream.off('response', onResponse);
      stream.off('error', onError);
    }

    function onError(_error) {
      cleanup();
      return _reject(_error);
    }

    function onResponse(_out) {
      cleanup();

      const proto = {};
      const status = _out[http2.constants.HTTP2_HEADER_STATUS];

      Object.defineProperties(proto, {
        headers: {enumerable: true, value: Object.freeze(_out)},
        status: {enumerable: true, value: status},
        ok: {enumerable: true, value: status >= 200 && status < 300},
        text: {enumerable: true, value: () => streamText(stream)},
        json: {enumerable: true, value: () => streamJSON(stream)}
      });

      return _resolve(proto);
    }

    stream.on('error', onError);
    stream.on('response', onResponse);

    stream.end(options.body);
  });
}

function sessionClose(_session) {
  return new Promise((_resolve, _reject) => {
    function cleanup() {
      _session.off('error', onError);
      _session.off('close', onClose);
    }

    function onError(_error) {
      cleanup();
      return _reject(_error);
    }

    function onClose() {
      cleanup();
      return _resolve();
    }

    _session.on('error', onError);
    _session.on('close', onClose);
    _session.close();
  });
}

function createSession(_url, _options) {
  return new Promise((_resolve, _reject) => {
    const session = http2.connect(_url, _options);

    function cleanup() {
      session.off('error', onError);
      session.off('connect', onConnect);
    }

    function onError(_error) {
      cleanup();
      return _reject(_error);
    }

    function onConnect() {
      const proto = {};

      cleanup();

      Object.defineProperties(proto, {
        request: {enumerable: true, value: _in => sessionRequest(session, _in)},
        close: {enumerable: true, value: () => sessionClose(session)}
      });

      return _resolve(proto);
    }

    session.on('error', onError);
    session.on('connect', onConnect);
  });
}

async function fetch(_url, _options = {}) {
  const session = await createSession(_url, _options.session);
  const res = await session.request(_options);

  try {
    await session.close();
  } catch (ex) {
    // Swallow the error
  }

  return res;
}

module.exports = {
  default: fetch,
  constants: http2.constants,
  fetch,
  createSession
};
