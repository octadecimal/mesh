import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { detectBillingOverrides } from './config.js';
import { registerRoutes, type HttpDependencies } from './http/routes.js';
import { registerSocketHub } from './realtime/socket-hub.js';

export interface OriginPolicy {
  readonly accepting: boolean;
  allows(origin: string | undefined): boolean;
  setServedOrigin(origin: string): void;
  stopAccepting(): void;
}

export const createOriginPolicy = (
  developmentOrigin?: string,
): OriginPolicy => {
  let accepting = true;
  let servedOrigin: string | undefined;
  return {
    get accepting() {
      return accepting;
    },
    allows: (origin) =>
      origin !== undefined &&
      (origin === servedOrigin || origin === developmentOrigin),
    setServedOrigin: (origin) => {
      servedOrigin = origin;
    },
    stopAccepting: () => {
      accepting = false;
    },
  };
};

type AppDependencies = HttpDependencies & {
  servedOrigin?: string;
  originPolicy?: OriginPolicy;
  webRoot?: string;
};

export const buildApp = (dependencies: AppDependencies): FastifyInstance => {
  const app = Fastify({ logger: false });
  const originPolicy = dependencies.originPolicy ?? createOriginPolicy();
  if (!dependencies.originPolicy) {
    originPolicy.setServedOrigin(
      dependencies.servedOrigin ?? 'http://127.0.0.1:3000',
    );
  }

  app.addHook('onRequest', async (request, reply) => {
    const isCommand =
      request.method === 'POST' && request.url.startsWith('/api/commands');
    const isUpgrade = request.url.startsWith('/api/socket');
    if (!originPolicy.accepting && (isCommand || isUpgrade)) {
      return reply.code(503).send();
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !originPolicy.allows(origin)) {
      return reply.code(403).send();
    }
    if (origin !== undefined) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      reply.header('access-control-allow-headers', 'content-type');
      return reply.code(204).send();
    }
  });

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
    originPolicy,
  });
  if (dependencies.webRoot) {
    void app.register(staticFiles, {
      root: dependencies.webRoot,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?', 1)[0];
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        path !== '/api' &&
        !path?.startsWith('/api/')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'not_found' } });
    });
  }
  return app;
};
