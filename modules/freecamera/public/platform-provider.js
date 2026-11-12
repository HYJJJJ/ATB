import { createComputeProvider } from '/compute-provider.js';

// The platform invokes declared background entries only after account login.
export function activate({ config } = {}) {
  const provider = config?.acceptsComputeProvider ? createComputeProvider() : null;
  provider?.start();
  return { close: async () => { await provider?.stop(); } };
}
