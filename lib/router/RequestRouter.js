'use strict';

const CustomError = require('../CustomError');
const helperPromises = require('../helpers/promises');

class RequestRouter {

  constructor(locator) {
    this._routesFactory = locator.resolve('routesFactory');
    this._events = locator.resolve('events');
    this._locator = locator;

    this._routesByMethod = null;
    this._routesByCollectionName = null;
  }

  /**
   * Serial call of middlewares
   *
   * @param {IncomingMessage} request Request
   * @param {ServerResponse} response Response
   * @param {Object} state State
   * @return {Promise} Promise that will resolve when all middleware called
   */
  callMiddlewares(request, response, state) {
    let middlewares;

    try {
      middlewares = this._locator.resolveAll('middleware');
    } catch (e) {
      // Middlewares not found
      return Promise.resolve();
    }

    const promises = middlewares.map(middleware => (() => middleware(request, response, state)));

    return helperPromises.serial(promises);
  }

  /**
   * Incoming message handler
   *
   * @param {IncomingMessage} request Request
   * @param {ServerResponse} response Response
   */
  requestListener(request, response) {
    const location = request.getLocation();
    const formatterProvider = this._locator.resolve('formatterProvider');

    this._events.emit('incomingMessage', request);

    const match = this.findRoute(request.method, location.path);
    const state = match.state;
    let handle = null;

    if (!match) {
      handle = this.notImplementedHandle;
    } else {
      handle = match.route.handle;
    }

    Promise.resolve()
      .then(() => this.callMiddlewares(request, response, state))
      .then(() => handle(request, response, match.state))
      .then(data => this.handleResultProcess(data, request, response, state))
      .then(data => {
        // for HEAD content should be empty
        if (request.method === 'HEAD') {
          return Promise.resolve();
        }

        const formatter = formatterProvider.getFormatter(data.context);

        if (!formatter) {
          throw new CustomError.InternalServerError('Not found formatter');
        }

        return formatter(data.context, data.result);
      })
      .then(result => response.send(result))
      .catch(reason => this.errorHandle(request, response, reason));
  }

  /**
   * Forwarding request to another collection
   *
   * @param {Object} forward Description of forwarding
   * @param {IncomingMessage} request Request
   * @param {ServerResponse} response Response
   * @param {Object} state Current state
   * @returns {Promise} Promise that will resolve when new route handle and handle result called
   */
  forwarding(forward, request, response, state) {
    const routes = this._routesByCollectionName[forward.collectionName];

    if (!routes) {
      const message = `Collection ${forward.collectionName} not found for forward`;
      return Promise.reject(new CustomError.InternalServerError(message, 'forwardCollectionNotFound'));
    }

    const route = routes[forward.handleName];

    if (!route) {
      const message = `Handle ${forward.handleName} not found for forward`;
      return Promise.reject(new CustomError.InternalServerError(message, 'forwardCollectionNotFound'));
    }

    this._events.emit('forwarding', `Forwarding to ${forward.collectionName}.${forward.handleName} ...`);

    return Promise
      .resolve(route.handle(request, response, state))
      .then(data => this.handleResultProcess(data, request, response, state));
  }

  /**
   * Processing result
   *
   * @param {Object} data Result from route.handle
   * @param {IncomingMessage} request Request
   * @param {ServerResponse} response Response
   * @param {Object} state Current state
   * @returns {Promise} Promise
   */
  handleResultProcess(data, request, response, state) {
    const context = data.context;

    if (context.actions.notFound) {
      throw new CustomError.NotFoundError(
        context.actions.notFound.message,
        context.actions.notFound.code
      );
    }

    if (context.actions.forward) {
      const forward = context.actions.forward;

      context.actions.forward = null;

      return this.forwarding(forward, request, response, state);
    }

    return data;
  }

  /**
   * Find route matched with current path
   *
   * @param {String} method HTTP method
   * @param {String} path Current URI
   * @returns {Object} Route and current state
   */
  findRoute(method, path) {
    const routes = this._routesByMethod[method.toLowerCase()] || [];
    let index = 0;
    let state = null;
    let route = null;

    while (!state && index < routes.length) {
      route = routes[index++];
      state = route.match(path);
    }

    if (!route) {
      return false;
    }

    return {
      route,
      state
    };
  }

  /**
   * Stub for not found handle
   * @param request
   * @returns {Promise}
   */
  notImplementedHandle(request) {
    return Promise.reject(
      new CustomError.NotImplementedError(`Resource or collection '${request.url}' not implemented in API`)
    );
  }

  /**
   * Final handler for Router
   *
   * @param request
   * @param response
   * @param error
   */
  errorHandle(request, response, error) {
    const env = 'development';

    if (!error) {
      return;
    }

    if (!(error instanceof CustomError)) {

      const newError = new CustomError.InternalServerError(error.message);
      newError.stack = error.stack;

      error = newError;
    }

    const prepared = Object.create(null);

    /* eslint guard-for-in: 0 */
    for (const prop in error) {
      prepared[prop] = error[prop];
    }

    if (env === 'production') {
      delete prepared.stack;
    } else if (env === 'development') {
      prepared.stack = error.stack;
    }

    this._events.emit('error', error.stack);

    const content = JSON.stringify({error: prepared});

    response.setStatus(error.status);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', Buffer.byteLength(content));
    response.send(content);
  }

  /**
   * Initialization routes
   *
   * @returns {Promise}
   */
  init() {
    return this._routesFactory
      .create()
      .then(routes => {

        this._routesByMethod = Object.create(null);
        this._routesByCollectionName = Object.create(null);

        routes.forEach(route => {
          const method = route.method;
          const collectionName = route.collectionName;
          const handleName = route.handleName;

          this._routesByMethod[method] = this._routesByMethod[method] || [];
          this._routesByMethod[method].push(route);

          this._routesByCollectionName[collectionName] =
            this._routesByCollectionName[collectionName] || Object.create(null);
          this._routesByCollectionName[collectionName][handleName] = route;
        });
      });
  }
}

module.exports = RequestRouter;