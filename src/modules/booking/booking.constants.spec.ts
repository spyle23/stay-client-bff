import { resolveBookingOptions } from './booking.constants';

describe('resolveBookingOptions', () => {
  it('applique les défauts documentés', () => {
    const options = resolveBookingOptions({});
    expect(options.maxStayNights).toBe(90);
  });

  /**
   * Même piège que `catalog` : une option fractionnaire est acceptée par `Number()` puis rejetée
   * plus bas (Redis, arithmétique de nuits) — borner sans normaliser est une validation en
   * trompe-l'œil.
   */
  it('normalise en entier', () => {
    const options = resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '30.9' });
    expect(options.maxStayNights).toBe(30);
    expect(Number.isInteger(options.maxStayNights)).toBe(true);
  });

  it('borne les valeurs hors plage et ignore les valeurs non parsables', () => {
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '0' }).maxStayNights,
    ).toBe(1);
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '99999' }).maxStayNights,
    ).toBe(365);
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: 'abc' }).maxStayNights,
    ).toBe(90);
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '  ' }).maxStayNights,
    ).toBe(90);
  });

  describe('hold de checkout et balayeur (story 2.4)', () => {
    it('applique les défauts documentés (hold 15 min, sursis 1 h)', () => {
      const options = resolveBookingOptions({});
      expect(options.holdTtlSeconds).toBe(900);
      expect(options.holdRecordGraceSeconds).toBe(3600);
      expect(options.sweeperIntervalMs).toBe(60_000);
      expect(options.sweeperBatchSize).toBe(50);
      expect(options.sweeperMaxAttempts).toBe(5);
    });

    /**
     * Le balayeur lit l'enregistrement (donc le `sid` du propriétaire) **après** l'échéance du
     * hold : un sursis nul rendrait toute annulation automatique impossible et gèlerait la chambre.
     */
    it('garantit un sursis strictement positif sur l’enregistrement', () => {
      const options = resolveBookingOptions({
        BOOKING_HOLD_GRACE_SECONDS: '0',
      });
      expect(options.holdRecordGraceSeconds).toBeGreaterThan(0);
    });

    /**
     * ⚠️ Ce test remplace un précédent dont le nom promettait « au-dessus du budget d'un appel
     * PMS » alors que son assertion entérinait un plancher de 5 000 ms — soit **moins qu'une seule
     * tentative** (8 s), pour une section critique qui enchaîne le pré-contrôle (4 appels
     * `catalog`, retryés) puis la création. Le verrou expirait donc pendant la création, et une
     * seconde requête pouvait créer un doublon : exactement ce qu'il prétendait empêcher.
     */
    it('borne le verrou de chambre au-dessus du budget d’un appel PMS complet', () => {
      const { stayLockTtlMs, pmsCallBudgetMs } = resolveBookingOptions({});
      expect(stayLockTtlMs).toBe(90_000);
      expect(stayLockTtlMs).toBeGreaterThanOrEqual(pmsCallBudgetMs);

      const clamped = resolveBookingOptions({
        BOOKING_STAY_LOCK_MS: '10',
      });
      expect(clamped.stayLockTtlMs).toBe(25_000);
      expect(clamped.stayLockTtlMs).toBeGreaterThanOrEqual(
        clamped.pmsCallBudgetMs,
      );
    });

    it('dérive le budget PMS de la configuration du client (jamais un doublon de réglage)', () => {
      // 8 s × 3 tentatives + backoff majoré (150 × 3 + 150 × 2) = 24 750 ms ≈ les « 25 s » citées
      // partout dans la documentation du module.
      expect(resolveBookingOptions({}).pmsCallBudgetMs).toBe(24_750);
      expect(
        resolveBookingOptions({ PMS_MAX_RETRIES: '0' }).pmsCallBudgetMs,
      ).toBe(8_000);
    });

    /**
     * Un verrou plus court que le budget PMS est un verrou décoratif : il donne l'illusion de la
     * sérialisation tout en expirant au milieu de la création. Le borner ne suffit pas — avec un
     * `PMS_TIMEOUT_MS` généreux, même le plafond du réglage passe dessous.
     */
    it('refuse au boot un verrou de chambre plus court que le budget PMS', () => {
      expect(() =>
        resolveBookingOptions({
          PMS_TIMEOUT_MS: '60000',
          PMS_MAX_RETRIES: '5',
        }),
      ).toThrow(/BOOKING_STAY_LOCK_MS/);
    });

    it('refuse au boot un report plus long que la durée de vie de l’enregistrement', () => {
      // Sinon, à la reprise, `read` renvoie null : l'entrée passe pour un index orphelin et
      // disparaît SANS annulation ni log d'erreur — chambre gelée en silence.
      expect(() =>
        resolveBookingOptions({
          BOOKING_HOLD_TTL_SECONDS: '300',
          BOOKING_HOLD_GRACE_SECONDS: '300',
          BOOKING_SWEEPER_INTERVAL_MS: '60000',
          BOOKING_SWEEPER_RETRY_MS: '3600000',
        }),
      ).toThrow(/BOOKING_SWEEPER_RETRY_MS/);
    });

    describe('délai de réconciliation des intentions (correctif D1)', () => {
      it('applique le défaut documenté et le borne', () => {
        expect(resolveBookingOptions({}).intentReconcileDelayMs).toBe(90_000);
        expect(
          resolveBookingOptions({ BOOKING_INTENT_RECONCILE_MS: '1000' })
            .intentReconcileDelayMs,
        ).toBe(30_000);
        expect(
          resolveBookingOptions({ BOOKING_INTENT_RECONCILE_MS: '99999999' })
            .intentReconcileDelayMs,
        ).toBe(600_000);
      });

      it('reste strictement au-delà du budget PMS avec les défauts', () => {
        const options = resolveBookingOptions({});
        expect(options.intentReconcileDelayMs).toBeGreaterThan(
          options.pmsCallBudgetMs,
        );
      });

      it('refuse au boot un délai qui réconcilierait une création encore en vol', () => {
        // Le balayeur annulerait une réservation que le voyageur est en train de voir apparaître.
        expect(() =>
          resolveBookingOptions({
            // Budget PMS ≈ 298 s : le verrou de chambre est monté en conséquence, mais le délai
            // de réconciliation resterait, lui, sous le budget.
            PMS_TIMEOUT_MS: '99000',
            PMS_MAX_RETRIES: '2',
            BOOKING_STAY_LOCK_MS: '300000',
          }),
        ).toThrow(/BOOKING_INTENT_RECONCILE_MS/);
      });
    });

    it('refuse au boot une scrutation plus lente que l’attente du verrou', () => {
      expect(() =>
        resolveBookingOptions({
          BOOKING_LOCK_POLL_MS: '2000',
          BOOKING_LOCK_WAIT_MS: '1000',
        }),
      ).toThrow(/BOOKING_LOCK_POLL_MS/);
    });

    it('refuse au boot un balayeur plus lent que le hold qu’il doit libérer', () => {
      // Sinon l'inventaire reste gelé bien au-delà de la promesse faite au voyageur.
      expect(() =>
        resolveBookingOptions({
          BOOKING_HOLD_TTL_SECONDS: '300',
          BOOKING_SWEEPER_INTERVAL_MS: '600000',
        }),
      ).toThrow(/BOOKING_SWEEPER_INTERVAL_MS/);
    });

    it('coupe le balayeur sous NODE_ENV=test (les suites e2e bootent AppModule)', () => {
      expect(resolveBookingOptions({ NODE_ENV: 'test' }).sweeperEnabled).toBe(
        false,
      );
      expect(
        resolveBookingOptions({ NODE_ENV: 'production' }).sweeperEnabled,
      ).toBe(true);
    });

    it('laisse la configuration explicite primer sur NODE_ENV', () => {
      expect(
        resolveBookingOptions({
          NODE_ENV: 'test',
          BOOKING_SWEEPER_ENABLED: 'true',
        }).sweeperEnabled,
      ).toBe(true);
    });

    /**
     * ⚠️ Le drapeau commande un composant qui **annule de vraies réservations**. La comparaison
     * stricte à `'false'` faisait ACTIVER le balayeur sur `0`, `no`, `off` ou `FALSE` — l'exact
     * inverse de l'intention de l'exploitant, et sans le moindre signal.
     */
    it.each(['false', 'FALSE', ' False ', '0', 'no', 'off', 'n'])(
      'coupe le balayeur sur « %s »',
      (raw) => {
        expect(
          resolveBookingOptions({
            NODE_ENV: 'production',
            BOOKING_SWEEPER_ENABLED: raw,
          }).sweeperEnabled,
        ).toBe(false);
      },
    );

    it.each(['true', 'TRUE', '1', 'yes', 'on'])(
      'active le balayeur sur « %s »',
      (raw) => {
        expect(
          resolveBookingOptions({
            NODE_ENV: 'test',
            BOOKING_SWEEPER_ENABLED: raw,
          }).sweeperEnabled,
        ).toBe(true);
      },
    );

    it('retombe sur NODE_ENV quand le drapeau est vide (jamais une décision par défaut cachée)', () => {
      expect(
        resolveBookingOptions({ NODE_ENV: 'test', BOOKING_SWEEPER_ENABLED: '' })
          .sweeperEnabled,
      ).toBe(false);
    });
  });
});
