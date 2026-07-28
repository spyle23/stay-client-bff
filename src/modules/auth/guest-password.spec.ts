import {
  GUEST_PASSWORD_LENGTH,
  generateGuestPassword,
  satisfiesPmsPasswordPolicy,
} from './guest-password';

/**
 * Le PMS refuse (400) tout mot de passe hors politique — et ce 400 est **indiscernable** d'une
 * collision d'email côté BFF. Un générateur qui échoue une fois sur N produirait donc des
 * « email déjà pris » aléatoires sur des adresses libres. D'où le tirage massif ci-dessous.
 */
describe('generateGuestPassword (story 2.3)', () => {
  it('respecte la politique PMS sur 1 000 tirages', () => {
    for (let i = 0; i < 1_000; i++) {
      const password = generateGuestPassword();
      expect(satisfiesPmsPasswordPolicy(password)).toBe(true);
    }
  });

  it('produit la longueur attendue', () => {
    expect(generateGuestPassword()).toHaveLength(GUEST_PASSWORD_LENGTH);
  });

  it('ne produit aucun doublon sur 200 tirages', () => {
    const draws = new Set(
      Array.from({ length: 200 }, () => generateGuestPassword()),
    );
    expect(draws.size).toBe(200);
  });

  /**
   * Sans mélange, les 4 premières positions seraient **déterministes par classe**
   * (majuscule, minuscule, chiffre, spécial) : un attaquant connaîtrait la structure du
   * secret. Supprimer la boucle de Fisher-Yates ne changerait ni la longueur, ni la politique,
   * ni l'alphabet — donc aucune autre assertion de ce fichier ne le remarquerait.
   */
  it('mélange les positions : aucune classe n’est figée sur son index', () => {
    const CLASSES = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^a-zA-Z0-9]/];
    const draws = Array.from({ length: 400 }, () => generateGuestPassword());

    CLASSES.forEach((classPattern, index) => {
      // Si la position `index` était figée, TOUS les tirages y porteraient cette classe.
      const alwaysAtItsIndex = draws.every((password) =>
        classPattern.test(password[index]),
      );
      expect(alwaysAtItsIndex).toBe(false);
    });
  });

  it('consomme une source cryptographique, pas Math.random', () => {
    const spy = jest.spyOn(Math, 'random');
    generateGuestPassword();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("n'émet que des caractères ASCII imprimables sûrs en JSON", () => {
    for (let i = 0; i < 200; i++) {
      // Ni guillemet, ni antislash, ni espace : rien qui puisse mal s'échapper dans un corps
      // JSON, un log ou une URL, et rien qu'un trim côté PMS pourrait altérer.
      expect(generateGuestPassword()).toMatch(/^[A-Za-z0-9!@#$%^&*_+=?-]+$/);
    }
  });
});

describe('satisfiesPmsPasswordPolicy', () => {
  // Miroir exact de RegisterCustomerRequestValidator.cs (l.26-32).
  it.each([
    ['Abcdefg1!', true],
    ['Abcd1!', false], // < 8 caractères
    ['abcdefg1!', false], // pas de majuscule
    ['ABCDEFG1!', false], // pas de minuscule
    ['Abcdefgh!', false], // pas de chiffre
    ['Abcdefg12', false], // pas de caractère spécial
  ])('%s → %s', (password, expected) => {
    expect(satisfiesPmsPasswordPolicy(password)).toBe(expected);
  });
});
