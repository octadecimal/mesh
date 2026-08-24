import Fastify, { type FastifyInstance } from 'fastify';

import { detectBillingOverrides } from './config.js';
import { registerRoutes, type HttpDependencies } from './http/routes.js';
import { registerSocketHub } from './realtime/socket-hub.js';

type AppDependencies = HttpDependencies & {
  servedOrigin?: string;
};

export const buildApp = (dependencies: AppDependencies): FastifyInstance => {
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    dependencies.billingConflicts === undefined
      ? {
          ...dependencies,
          billingConflicts: detectBillingOverrides(process.env),
        }
      : dependencies,
  );
  registerSocketHub(app, {
    events: dependencies.events,
    publisher: dependencies.registry.publisher,
    servedOrigin: dependencies.servedOrigin ?? 'http://127.0.0.1:3000',
  });
  return app;
};
