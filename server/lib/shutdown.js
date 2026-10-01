/** One deadline covers HTTP requests, deferred work and database teardown. */
export function createShutdownHandler({ server, drain, closeDatabase,
  timeoutMs = 45_000, exit = code => process.exit(code),
  log = message => console.log(message), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let shutdown;
  return function stop() {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      log('Shutdown requested; stopping new requests and draining current work.');
      let timer;
      const deadline = new Promise(resolve => {
        timer = setTimer(() => resolve('timeout'), timeoutMs);
      });
      const finish = (async () => {
        await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
        await drain();
        await closeDatabase();
        return 'complete';
      })().catch(() => 'failed');
      const result = await Promise.race([finish,deadline]);
      clearTimer(timer);
      if (result !== 'complete') {
        server.closeAllConnections?.();
        log('Shutdown incomplete; saved job leases and provider outcomes require reconciliation.');
        exit(1);
      } else {
        log('Shutdown complete; current work settled and database closed.');
        exit(0);
      }
      return result;
    })();
    return shutdown;
  };
}
