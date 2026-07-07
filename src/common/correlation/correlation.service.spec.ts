import type { NextFunction, Request, Response } from 'express';
import { correlationStorage, getCorrelationId } from './correlation.context';
import { correlationMiddleware } from './correlation.middleware';
import { CorrelationService } from './correlation.service';

describe('correlation', () => {
  it('getCorrelationId renvoie undefined hors contexte', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it("expose l'id dans le contexte ALS (context + service)", () => {
    correlationStorage.run({ correlationId: 'abc' }, () => {
      expect(getCorrelationId()).toBe('abc');
      expect(new CorrelationService().getCorrelationId()).toBe('abc');
    });
  });

  describe('middleware', () => {
    function mockReqRes(headerVal?: string) {
      const headers = headerVal ? { 'x-correlation-id': headerVal } : {};
      const req = { headers } as unknown as Request;
      const setHeader = jest.fn();
      const res = { setHeader } as unknown as Response;
      return { req, res, setHeader };
    }

    it("génère un id quand absent, pose l'en-tête et ouvre le contexte", () => {
      const { req, res, setHeader } = mockReqRes();
      let seen: string | undefined;
      const next: NextFunction = () => {
        seen = getCorrelationId();
      };
      correlationMiddleware(req, res, next);
      expect(seen).toMatch(/[0-9a-f-]{36}/);
      expect(setHeader).toHaveBeenCalledWith('X-Correlation-ID', seen);
    });

    it('réutilise un id fourni en en-tête', () => {
      const { req, res, setHeader } = mockReqRes('given-id');
      let seen: string | undefined;
      const next: NextFunction = () => {
        seen = getCorrelationId();
      };
      correlationMiddleware(req, res, next);
      expect(seen).toBe('given-id');
      expect(setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'given-id');
    });

    it('régénère un id si la valeur entrante est invalide (contrôle/charset)', () => {
      const { req, res } = mockReqRes('bad\r\ninjected');
      let seen: string | undefined;
      const next: NextFunction = () => {
        seen = getCorrelationId();
      };
      correlationMiddleware(req, res, next);
      expect(seen).not.toBe('bad\r\ninjected');
      expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('le contexte ALS survit à travers un await (chaîne async)', async () => {
      const { req, res } = mockReqRes('async-id');
      const seen = await new Promise<string | undefined>((resolve) => {
        const next: NextFunction = () => {
          setTimeout(() => resolve(getCorrelationId()), 5);
        };
        correlationMiddleware(req, res, next);
      });
      expect(seen).toBe('async-id');
    });
  });
});
