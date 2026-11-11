# Flipdar — moniteur Vinted temps réel

Interface web (hébergée gratuitement sur GitHub Pages) pour l'achat-revente sur Vinted :

- **Moniteurs en temps réel** : colle un lien de recherche Vinted (avec tous tes filtres) ou des mots-clés. Les annonces sont lues directement dans la page de recherche Vinted (Vinted n'a plus d'API publique pour la recherche) ; une adresse d'API n'est utilisée que si elle a été vérifiée (résultats conformes à la recherche, triés du plus récent).
- **Âge réel des annonces** : chaque nouvelle carte indique **depuis quand elle est apparue dans la recherche** (« vu 3 s ») et **depuis quand elle est publiée** (« ajouté il y a ~2 min »). Quand Vinted ne donne pas la date, Flipdar la calcule avec son « horloge Vinted » (les numéros d'annonce augmentent avec le temps) recalée sur le « Ajouté il y a… » des pages Vinted ; « ~ » = estimé. Une annonce est « nouvelle » dès qu'elle apparaît dans la recherche ; seules les annonces très anciennes (remises en ligne, > 2 h par défaut) sont exclues des alertes et de l'achat auto.
- **Estimation de revente** : comparaison avec les articles de **même marque et même type** (pull, veste, jean… reconnus en plusieurs langues), ajustée à l'état. Priorité aux **ventes réelles** relevées par Flipdar, sinon aux annonces similaires (prix sous lequel se trouvent 40 % d'entre elles, pour vendre vite). S'il manque des comparables, Flipdar lance tout seul une recherche ciblée (« Ralph Lauren pull »). Un point de couleur indique la confiance (vert / orange / rouge) ; pas de badge « bonne affaire » ni d'achat auto sur une estimation peu fiable.
- **⚡ Achat** : une petite fenêtre Vinted s'ouvre dans le coin de l'écran, le bot clique « Acheter », vérifie le total, puis clique « Payer » (ou s'arrête avant en **simulation**, activée par défaut). Tu suis tout dans la fenêtre de progression de Flipdar. Le moyen de paiement est celui enregistré sur ton compte Vinted : c'est toi qui le choisis sur Vinted.
- Son, notifications bureau, webhook Discord pour les bonnes affaires, multi-pays (FR, BE, ES, IT, DE…), bouton **Exporter un diagnostic**.

## Comment ça marche

```
GitHub Pages (site/)  ⇄  extension « Flipdar Bridge » (extension/)  ⇄  onglet Vinted réduit  ⇄  Vinted
```

- Le site ne peut pas appeler Vinted directement : l'extension sert de pont, avec **ta** session Vinted et **ton** adresse internet.
- **Moteur de recherche** : l'extension garde un onglet Vinted dans une fenêtre réduite, posé sur une page sans application (robots.txt) : aucun trafic en arrière-plan. Les recherches partent de cet onglet, avec ta session, comme celles du site Vinted. Ne ferme pas cette fenêtre (elle se recrée sinon).
- **API** : depuis cet onglet, Flipdar teste les adresses d'API de recherche (une fois, puis toutes les 6 h). Si l'une renvoie vraiment ta recherche, triée du plus récent, il l'utilise (« ⚡ via API », plus léger). Sinon il lit la page de résultats (« via onglet Vinted »).
- **Vérification automatique** : au début, toutes les 10 min et dès 2 min sans nouvelle annonce, une requête de la page de résultats (comme un F5, sans la charger) est comparée à la recherche. En cas d'écart, Flipdar bascule sur la page de résultats. Sous chaque recherche : « ✓ identique à Vinted » ou « ⚠ … ».
- Limiteur anti-blocage : 15 requêtes/min au maximum (plafond qui baisse après un blocage), pause automatique si Vinted répond « rate limited ».

## Mise en ligne

1. Crée un dépôt GitHub et pousse ce dossier sur la branche `main`.
2. Dans le dépôt : **Settings → Pages → Source : GitHub Actions**.
3. Le workflow publie le site sur `https://<ton-pseudo>.github.io/<dépôt>/` et y met l'extension en téléchargement (`flipdar-extension.zip`).

## Installer l'extension

1. Télécharge `flipdar-extension.zip` depuis ton site (ou utilise le dossier `extension/`) et dézippe-le.
2. Chrome / Edge / Brave : `chrome://extensions` → *Mode développeur* → *Charger l'extension non empaquetée* → choisis le dossier.
3. Connecte-toi sur vinted.fr dans le même navigateur, puis recharge Flipdar : le statut passe à **Connecté**.

Test en local : `python3 -m http.server -d site 8000` puis http://localhost:8000.

## Achat automatique

Trois verrous, tous nécessaires :
1. **Popup de l'extension** (icône Flipdar Bridge) : activer l'achat auto, cliquer « Autoriser ce site » depuis ton site Flipdar, fixer max/article, budget/jour, achats/jour. Ces plafonds sont appliqués par l'extension elle-même.
2. **Panneau « Achat automatique »** du site : interrupteur général + simulation (désactive-la seulement quand tout fonctionne).
3. **Règles par moniteur** : bouton ⚡ dans la liste des moniteurs.

Avant de cliquer « Payer », l'extension vérifie que le total affiché (frais + port compris) ne dépasse pas prix TTC + « frais de port max ». Sinon elle annule.
Prérequis côté Vinted : adresse, mode de livraison et carte déjà enregistrés. Si ta banque demande une validation 3-D Secure, l'onglet passe au premier plan pour que tu valides.

## Base de ventes

Stockée dans ton navigateur (IndexedDB), elle grossit toute seule tant que Flipdar tourne. Plus tu laisses tourner, meilleure est l'estimation.
Pense à l'**exporter** de temps en temps (bouton dans le panneau), et à l'importer sur un autre PC.

## Réglages conseillés

- **Intervalle** 3–5 s par moniteur et **écart mini** ≥ 500 ms. En dessous, Vinted renvoie des 429/403 : Flipdar se met alors en pause automatiquement (backoff exponentiel).
- Toutes les requêtes passent par un seul ordonnanceur : 5 moniteurs à 600 ms d'écart = ~100 requêtes/min au total. Les vérifications de ventes (12/min par défaut) passent dans les temps morts.

### Ce qui limite le risque de ban
Requêtes depuis ton navigateur et ton IP, avec ta vraie session (aucun serveur ni proxy suspect). Rythme irrégulier (±20 %), pause automatique dès que Vinted renvoie 429/403. Achat via le vrai tunnel de paiement avec un délai humain, un seul à la fois, plafonné par jour. **Aucune garantie** cependant : Vinted peut bannir n'importe quel compte automatisé.

## Tests

Le dossier `test/` contient un faux Vinted (HTTPS) et un test de bout en bout qui charge la vraie extension dans Chromium :
recherche, simulation, achat, article vendu, âges, estimations et blocage « rate limited ».

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/mock-vinted.key -out /tmp/mock-vinted.crt -days 30 -subj "/CN=www.vinted.fr" -addext "subjectAltName=DNS:www.vinted.fr,DNS:api.vinted.fr"
sudo node test/mock-vinted.js &
(cd site && python3 -m http.server 8766) &
node test/e2e.js
```

## Limites (à savoir)

- L'automatisation est contraire aux conditions d'utilisation de Vinted : un rythme trop agressif peut faire bloquer ton compte. Reste raisonnable.
- Les premières heures, l'estimation repose sur les prix demandés : les ventes réelles s'accumulent au fil du suivi.
- Le script d'achat repère le bouton « Payer » par son texte. Si Vinted refait sa page de paiement, il faudra adapter `extension/checkout.js`. Teste toujours en simulation après une mise à jour de Vinted.
- L'API Vinted n'est pas officielle et peut changer ; le code d'appel est isolé dans `extension/background.js`.
