/**
 * Environnement **hermétique** des tests e2e (story 2.1).
 *
 * `resolveAuthOptions` est fail-fast : sans `SESSION_SECRET`, le boot d'`AppModule` échoue.
 * Les tests ne doivent dépendre ni d'un `.env` local (gitignoré, absent en CI) ni de la machine.
 * Deux garanties complémentaires :
 * - ici, une valeur déterministe est **imposée** (affectation directe, pas `??=` : une variable
 *   traînant dans le shell du développeur changerait sinon le secret réellement utilisé) ;
 * - dans `AppModule`, `ConfigModule` est configuré avec `ignoreEnvFile` quand `NODE_ENV === 'test'`,
 *   afin qu'aucun `.env` local ne s'invite dans les suites.
 */
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET =
  'e2e-test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
