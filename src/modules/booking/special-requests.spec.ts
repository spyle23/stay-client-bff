import {
  COMMUNICATION_LOCALES,
  isCommunicationLocale,
  normalizeSpecialRequests,
  SPECIAL_REQUESTS_MAX_LENGTH,
} from './special-requests';

describe('normalizeSpecialRequests', () => {
  it('renvoie null pour une valeur absente, vide ou entièrement blanche', () => {
    expect(normalizeSpecialRequests(undefined)).toBeNull();
    expect(normalizeSpecialRequests(null)).toBeNull();
    expect(normalizeSpecialRequests('')).toBeNull();
    expect(normalizeSpecialRequests('   ')).toBeNull();
    expect(normalizeSpecialRequests('\n\n\t  \n')).toBeNull();
  });

  it('renvoie null pour un contenu réduit à néant par la normalisation', () => {
    // Que des caractères de contrôle : après normalisation il ne reste rien à transmettre.
    expect(normalizeSpecialRequests('\u0000\u0007\u001b')).toBeNull();
  });

  it('laisse passer une valeur non textuelle sans la convertir', () => {
    // La conversion appartient à `@IsString` : fabriquer « 42 » ferait passer pour une demande
    // spéciale ce qui est en réalité une requête malformée.
    expect(normalizeSpecialRequests(42)).toBe(42);
    expect(normalizeSpecialRequests(['a'])).toEqual(['a']);
  });

  it('coupe les blancs de bord sans toucher au contenu', () => {
    expect(normalizeSpecialRequests('  Arrivée tardive  ')).toBe(
      'Arrivée tardive',
    );
  });

  it('normalise les fins de ligne Windows et les CR isolés en \\n', () => {
    expect(normalizeSpecialRequests('Ligne 1\r\nLigne 2\rLigne 3')).toBe(
      'Ligne 1\nLigne 2\nLigne 3',
    );
  });

  it('retire les caractères de contrôle mais préserve les retours à la ligne', () => {
    expect(normalizeSpecialRequests('Chambre\u0000calme\nMerci')).toBe(
      'Chambre calme\nMerci',
    );
  });

  it('remplace un caractère de contrôle par une espace plutôt que de coller les mots', () => {
    // Un retrait « sec » produirait « Chambrecalme » — un mot inventé, illisible à la réception.
    expect(normalizeSpecialRequests('Chambre\tcalme')).toBe('Chambre calme');
    expect(normalizeSpecialRequests('Chambre\u001bcalme')).toBe(
      'Chambre calme',
    );
  });

  it('neutralise les caractères de formatage invisibles (bidi, zero-width)', () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) permet d'afficher un texte à l'envers dans le back-office,
    // où la réception lit ces demandes. U+200B (ZERO WIDTH SPACE) casse toute recherche texte.
    expect(normalizeSpecialRequests('Vue\u202emer')).toBe('Vue mer');
    expect(normalizeSpecialRequests('Vue\u200bmer')).toBe('Vue mer');
  });

  it('ne tronque jamais : la borne est un refus, pas une amputation silencieuse', () => {
    // Tronquer enverrait à l'hôtel une demande **amputée** que le voyageur croit complète.
    // La borne est portée par `@MaxLength` sur le DTO → 400 propre, jamais une valeur mutilée.
    const raw = 'a'.repeat(SPECIAL_REQUESTS_MAX_LENGTH + 500);
    expect(normalizeSpecialRequests(raw)).toHaveLength(
      SPECIAL_REQUESTS_MAX_LENGTH + 500,
    );
  });

  it('normalise AVANT toute mesure de longueur', () => {
    // Les blancs de bord ne doivent pas faire refuser un contenu qui tient dans la borne.
    const raw = `   ${'a'.repeat(SPECIAL_REQUESTS_MAX_LENGTH)}   `;
    expect(normalizeSpecialRequests(raw)).toHaveLength(
      SPECIAL_REQUESTS_MAX_LENGTH,
    );
  });

  /**
   * Revue 2ᵉ passe (F15) — l'ancien test employait un `é` **précomposé** (1 unité UTF-16) et
   * passait donc à l'identique quelle que soit la sémantique de comptage : il ne pouvait pas
   * attraper ce qu'il prétendait garder. Ce qui compte réellement, c'est l'**invariant de sûreté**
   * vis-à-vis de PostgreSQL, et il porte sur les caractères multi-unités.
   */
  it('la longueur mesurée MAJORE toujours le nombre de caractères PostgreSQL', () => {
    // `@MaxLength` compte des unités UTF-16 ; PostgreSQL compte des points de code. Une unité vaut
    // au plus un point de code, donc borner en UTF-16 ne peut jamais laisser passer plus de
    // caractères que la borne — c'est ce qui rend la marge 1000/2000 sûre par construction.
    const cas = [
      ['accent précomposé', 'é'.repeat(600)],
      ['accent décomposé (macOS)', 'é'.repeat(600)],
      ['emoji hors BMP', '👨'.repeat(600)],
      ['emoji composé (ZWJ)', '👨\u200d👩\u200d👧'.repeat(60)],
    ] as const;

    for (const [label, texte] of cas) {
      const mesure = (normalizeSpecialRequests(texte) as string).length;
      const pointsDeCode = [...texte].length;
      expect(mesure).toBeGreaterThanOrEqual(pointsDeCode);
      // Et la conséquence concrète : sous la borne du BFF, on tient toujours dans la colonne PMS.
      if (mesure <= SPECIAL_REQUESTS_MAX_LENGTH) {
        expect(pointsDeCode).toBeLessThan(2000);
      }
      expect(label).toBeTruthy();
    }
  });

  it('ne fabrique ni ne perd de caractère en normalisant un texte déjà propre', () => {
    // Garde de non-régression du remplacement `\p{Cc}\p{Cf}` → espace : il ne doit toucher
    // à RIEN dans un texte ordinaire, accents et emoji compris.
    const propre = 'Chambre calme, vue mer 🌊 — étage élevé si possible.';
    expect(normalizeSpecialRequests(propre)).toBe(propre);
  });

  it('ne renvoie jamais une chaîne vide (null ou contenu, jamais "")', () => {
    // `""` serait persisté tel quel par le PMS : une demande spéciale « vide » au lieu d'absente.
    for (const raw of ['', ' ', '\t', '\r\n', '\u0000']) {
      expect(normalizeSpecialRequests(raw)).toBeNull();
    }
  });

  it('laisse au moins la moitié de la colonne PMS en marge (varchar 2000)', () => {
    // Revue 2ᵉ passe (F15) : `toBeLessThan(2000)` passait à 1999, ce qui n'est pas « une marge ».
    // La borne doit rester assez basse pour absorber toute divergence future de comptage entre
    // unités UTF-16 (ici) et caractères (PostgreSQL) — d'où le facteur 2, pas un simple `<`.
    expect(SPECIAL_REQUESTS_MAX_LENGTH).toBeLessThanOrEqual(2000 / 2);
  });
});

describe('isCommunicationLocale', () => {
  it('accepte exactement les langues supportées par le PMS', () => {
    // Revue 2ᵉ passe (F15) : `expect(COMMUNICATION_LOCALES).toEqual(['fr','en'])` comparait la
    // constante à sa propre copie — vrai par construction. Ce qu'il faut verrouiller, c'est
    // l'alignement sur `SupportedLanguages` de `EmailOutboxProcessor` (["fr","en"]), qui vit dans
    // un AUTRE dépôt : on l'écrit donc comme une liste attendue **indépendante**, et on vérifie que
    // le garde se comporte comme elle sur toute son étendue.
    const SUPPORTEES_PAR_LE_PMS = ['fr', 'en'];
    for (const langue of SUPPORTEES_PAR_LE_PMS) {
      expect(isCommunicationLocale(langue)).toBe(true);
    }
    // Et rien au-delà : une langue proposée mais non rendue par le mailer retomberait en silence
    // sur « fr » le jour où D10 sera livré.
    expect(COMMUNICATION_LOCALES).toHaveLength(SUPPORTEES_PAR_LE_PMS.length);
  });

  it('refuse toute autre valeur, y compris une locale complète ou une autre casse', () => {
    // La comparaison du PMS est `StringComparer.Ordinal` : « FR » n'y est PAS « fr ».
    expect(isCommunicationLocale('de')).toBe(false);
    expect(isCommunicationLocale('fr-FR')).toBe(false);
    expect(isCommunicationLocale('FR')).toBe(false);
    expect(isCommunicationLocale('')).toBe(false);
    expect(isCommunicationLocale(undefined)).toBe(false);
    expect(isCommunicationLocale(null)).toBe(false);
    expect(isCommunicationLocale(42)).toBe(false);
  });
});
