import { createServer } from 'node:http';

/**
 * The HTTP health endpoint.
 *
 * A hosting platform needs one thing from a long-running process: a port that
 * answers. This binds one, and nothing else - it is not an API, it has no
 * routes that read state, and it deliberately cannot report anything an
 * operator would not put in a screenshot.
 *
 * Two properties matter more than the response body:
 *
 *   - IT BINDS BEFORE DISCORD. The port is opened before the gateway login is
 *     attempted, so a slow, refused or endlessly reconnecting Discord
 *     connection cannot make the platform think the service is dead.
 *   - ITS FAILURE IS NOT FATAL TO THE BOT. A port already in use is logged
 *     loudly and the bots carry on: music and chat do not depend on this
 *     socket. On a platform, the failed health check is itself the signal.
 */

export const DEFAULT_PORT = 10000;

/** Render and every comparable platform expect a wildcard bind. */
export const DEFAULT_HOST = '0.0.0.0';

export const SERVICE_NAME = 'PompBots';

/** Paths that answer. Everything else is a 404. */
export const HEALTH_PATHS = Object.freeze(['/', '/health']);

/**
 * The exact response body, built field by field.
 *
 * Written as an explicit allowlist rather than by spreading anything: the
 * payload is the one thing here that leaves the process, so what it can contain
 * has to be readable at a glance. No token, key, guild id, config value or
 * database row is reachable from this function.
 *
 * @param {object} options
 * @param {{ pompAI: boolean, pompMusic: boolean }} options.status
 * @param {number} options.startedAt
 * @param {() => number} options.now
 */
export function buildHealthPayload({ status, startedAt, now = Date.now }) {
  return {
    // The service is answering, which is all the platform asked about. A bot
    // that failed to log in is reported in its own field, not by failing the
    // check: restarting the container would not fix a bad token.
    ok: true,
    service: SERVICE_NAME,
    pompAI: Boolean(status?.pompAI),
    pompMusic: Boolean(status?.pompMusic),
    uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.port] Defaults to `PORT`, then 10000.
 * @param {string} [options.host]
 * @param {object} [options.status] Live flags, read on each request.
 * @param {object} [options.logger]
 * @param {number} [options.startedAt]
 * @param {() => number} [options.now]
 * @param {object} [options.env]
 */
export function createHealthServer({
  port = undefined,
  host = DEFAULT_HOST,
  status = { pompAI: false, pompMusic: false },
  logger = null,
  startedAt = Date.now(),
  now = Date.now,
  env = process.env,
} = {}) {
  const resolvedPort = resolvePort(port ?? env.PORT);
  const started = { value: false };
  /** Open sockets, so shutdown does not wait on a keep-alive connection. */
  const sockets = new Set();

  const server = createServer((request, response) => {
    let path;
    try {
      // A malformed request target must not throw inside the handler.
      path = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      respond(response, 400, { ok: false, error: 'bad-request' });
      return;
    }

    if (!HEALTH_PATHS.includes(path)) {
      respond(response, 404, { ok: false, error: 'not-found' });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET, HEAD' });
      return;
    }

    respond(response, 200, buildHealthPayload({ status, startedAt, now }));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function respond(response, code, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    response.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      // Health output is per-request and meaningless cached.
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    response.end(payload);
  }

  return {
    server,
    port: resolvedPort,
    host,

    /**
     * Binds the port.
     *
     * Never rejects: a port that cannot be taken is a loud log line, not a
     * dead bot. The return value says which happened so a caller (or a test)
     * can tell the difference.
     *
     * @returns {Promise<{ listening: boolean, port: number|null, reason: string|null }>}
     */
    start() {
      if (started.value) return Promise.resolve({ listening: true, port: resolvedPort, reason: null });

      return new Promise((resolve) => {
        const onError = (error) => {
          server.off('listening', onListening);
          logger?.error?.(
            `The health endpoint could not bind ${host}:${resolvedPort} (${error?.code ?? 'unknown error'}). ` +
              'The bots keep running; a hosting platform will fail its health check instead.',
            { code: error?.code ?? null, port: resolvedPort },
          );
          resolve({ listening: false, port: null, reason: error?.code ?? 'unknown error' });
        };

        const onListening = () => {
          server.off('error', onError);
          started.value = true;
          logger?.info?.('Health endpoint listening.', { host, port: resolvedPort });
          resolve({ listening: true, port: resolvedPort, reason: null });
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(resolvedPort, host);
      });
    },

    /**
     * Closes the port and every connection on it.
     *
     * `server.close()` alone waits for keep-alive connections to end, which on
     * a proxied platform can be long enough to blow the shutdown deadline, so
     * the open sockets are destroyed as well.
     */
    async stop() {
      if (!started.value) return false;
      started.value = false;

      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closed;
      return true;
    },

    /** The bound address, or null when not listening. */
    address() {
      return server.address();
    },

    get listening() {
      return started.value;
    },
  };
}

/** `PORT` wins when it is a usable port number; otherwise the platform default. */
export function resolvePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0 || value > 65535) return DEFAULT_PORT;
  return value;
}
