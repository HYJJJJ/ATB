import { createAssistantRoutes } from './assistant-routes.js';

export async function createModule(context) {
  const handle = await createAssistantRoutes(context);
  return { handle, close: () => handle.close() };
}
export default createModule;
