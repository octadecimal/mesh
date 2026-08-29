import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerV2Routes, type V2RouteDependencies } from './routes.js';

export type V2HttpAppOptions = {
  webRoot?: string;
};

export const createV2HttpApp = (
  dependencies: V2RouteDependencies,
  options: V2HttpAppOptions = {},
): FastifyInstance => {
  const app = Fastify({ logger: false });
  registerV2Routes(app, dependencies);
  if (options.webRoot) {
    void app.register(staticFiles, { root: options.webRoot });
  }
  return app;
};
