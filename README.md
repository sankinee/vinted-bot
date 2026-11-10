# Flipdar — moniteur Vinted temps réel

Interface web (hébergée gratuitement sur GitHub Pages) pour l'achat-revente sur Vinted :

- **Moniteurs en temps réel** : colle un lien de recherche Vinted (avec tous tes filtres) ou des mots-clés. Les nouvelles annonces apparaissent en quelques secondes.
- **⚡ Achat en un clic** : le bouton ouvre directement la page de paiement Vinted de l'article. Raccourci `B` = acheter le dernier article affiché.
- **Achat automatique** : règles par moniteur (prix max, profit min, remise min). L'extension ouvre le vrai tunnel de paiement Vinted, revérifie le total, puis clique « Payer ». Mode **simulation** activé par défaut.
- **Estimation sur prix VENDUS** : chaque annonce vue est suivie, puis sa page est revérifiée (30 min, 2 h, 6 h… jusqu'à 14 j). Quand elle passe « vendue », Flipdar enregistre le prix final et le délai de vente. L'estimation utilise ces ventes réelles (même marque + mots du titre, ajustées à l'état) et repasse sur les prix demandés tant qu'il n'y en a pas assez.
- Son, notifications bureau, webhook Discord pour les bonnes affaires, multi-pays (FR, BE, ES, IT, DE…).

## Comment ça marche

```
GitHub Pages (site/)  ⇄  extension « Flipdar Bridge » (extension/)  ⇄  API Vinted
```

Une page GitHub Pages ne peut pas appeler Vinted directement (CORS + protection anti-bot).
La petite extension Chrome sert de pont : elle fait les requêtes **depuis ton navigateur, avec ta session Vinted et ton IP**. Pas de serveur à payer, et une latence minimale.
L'extension n'autorise que la recherche catalogue (lecture seule) : aucune page ne peut acheter ou écrire à ta place.

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

## Limites (à savoir)

- L'automatisation est contraire aux conditions d'utilisation de Vinted : un rythme trop agressif peut faire bloquer ton compte. Reste raisonnable.
- Les premières heures, l'estimation repose sur les prix demandés : les ventes réelles s'accumulent au fil du suivi.
- Le script d'achat repère le bouton « Payer » par son texte. Si Vinted refait sa page de paiement, il faudra adapter `extension/checkout.js`. Teste toujours en simulation après une mise à jour de Vinted.
- L'API Vinted n'est pas officielle et peut changer ; le code d'appel est isolé dans `extension/background.js`.
