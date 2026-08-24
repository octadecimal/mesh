import Fastify, { type FastifyInstance } from 'fastify';

import { detectBillingOverrides } from './config.js';
import { registerRoutes, type HttpDependencies } from './http/routes.js';

export const buildApp = (dependencies: HttpDependencies): FastifyInstance => {
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
  return app;
};
