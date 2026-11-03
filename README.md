# Five du jeudi

Web app installable (PWA) pour organiser un five entre potes, auto-hébergée sur un NAS.
Node.js + SQLite, aucune dépendance externe en dehors d'Express, Web Push et (optionnellement) Nodemailer.

## Ce que ça fait

- **Match hebdo automatique** : le match du jeudi (jour, heure, lieu, nombre de places réglables) est créé tout seul X jours avant, et tout le monde est prévenu.
- **Lieux** : UrbanSoccer Montaudran par défaut. On change le lieu d'un match en un tap parmi les lieux enregistrés, et on peut planifier à l'avance un jeudi ailleurs (ou sans five) depuis le calendrier, avant même l'ouverture des inscriptions. Le lieu ouvre l'itinéraire dans Maps.
- **Inscription en un tap**, nombre d'utilisateurs illimité, accès protégé par un code d'invitation.
- **Liste d'attente** : au-delà des 12 places, on passe en attente. Si un titulaire se désiste, le premier de la liste remonte et reçoit une notification. Si les équipes étaient déjà faites, il prend la place laissée libre dans la même équipe.
- **+1 ponctuel** : au moment de s'inscrire (ou après), on ajoute un invité avec son prénom et un niveau estimé. Il prend une place (ou passe en attente si c'est complet). Si l'hôte se désiste, ses +1 partent avec lui.
- **Équipes équilibrées** : répartition calculée à partir du niveau de chacun et de l'historique des matchs (voir plus bas). Ajustement manuel possible, pronostic affiché, partage WhatsApp.
- **Stats perso** : matchs, V-N-D, % de victoires, buts, homme du match (vote des joueurs), désistements de dernière minute, forme sur les 5 derniers matchs, meilleur duo, courbe de l'indice de forme. Classement par saison (septembre → août).
- **Rappels automatiques** (notifications push, email en option) :
  - ouverture des inscriptions ;
  - relance des non-inscrits s'il reste des places (par défaut 26 h avant, soit le mercredi 18 h) ;
  - rappel aux joueurs avec leur équipe (par défaut 8 h avant, soit le jeudi midi) ;
  - instantané : place libérée, équipes faites, match modifié ou annulé, score saisi.

Rôles : le premier compte créé est **organisateur** (réglages du groupe, comptes, niveaux, et tout ce que fait un capitaine). Un organisateur peut nommer des **capitaines** : ils gèrent les matchs (équipes, score, lieu, date, inscrits, annulation) sans accès aux réglages ni aux comptes. Pratique pour déléguer quand l'organisateur n'est pas là.

## Essayer en local

```bash
npm install
npm run seed:demo   # base de démo : 14 joueurs, 6 matchs joués (mot de passe : demo1234)
DATA_DIR=./demo-data npm start
# -> http://localhost:3000, connexion "Mika" / demo1234
```

Pour démarrer à vide : `npm start`, puis ouvre http://localhost:3000. Le code d'invitation s'affiche dans les logs au premier lancement.

Tests : `npm test` (liste d'attente, +1, équilibrage, Elo, MVP, rappels, droits d'accès).

Node 22.13 minimum (SQLite intégré à Node, rien à compiler).

## Déploiement sur TrueNAS SCALE

### 1. Publier l'image

Chaque push sur `main` déclenche GitHub Actions : les tests tournent, puis l'image `ghcr.io/mikadvl/five-du-jeudi:latest` est construite (amd64 + arm64).

Après le premier build, va dans **GitHub > ton profil > Packages > five-du-jeudi > Package settings** et passe la visibilité en **Public**. Sinon, il faut ajouter un `docker login ghcr.io` sur le NAS. L'image ne contient aucun secret : les clés et les données sont créées au démarrage dans le dossier de données.

### 2. Créer le dossier de données

Dans un shell TrueNAS :

```bash
sudo mkdir -p /mnt/TANK_VAULT/APPS/FIVE
sudo chown 1000:1000 /mnt/TANK_VAULT/APPS/FIVE
```

Le conteneur tourne avec l'utilisateur 1000 (`node`), d'où le `chown`. Le chemin est déjà référencé dans `docker-compose.yml` (sensible à la casse).

### 3. Lancer l'app

**Apps > Discover Apps > ⋮ > Install via YAML**, nom `five` (minuscules uniquement), colle le contenu de `docker-compose.yml` en remplaçant :

- `VAPID_SUBJECT` par `mailto:` + ton adresse mail ;
- `INVITE_CODE` par le code que tu veux donner aux potes.

L'app écoute sur le port **8096** du NAS. La base est créée au premier démarrage.

### 4. Exposer en HTTPS avec npmplus

Proxy host `five.vaultnode.fr` → `http://192.168.10.20:8096`, avec certificat Let's Encrypt et Force SSL.

> Le HTTPS est obligatoire : sans lui, pas d'installation en PWA ni de notifications push.

Si tu choisis un autre sous-domaine, mets-le aussi dans `APP_URL`.

### 5. Premier lancement

1. Ouvre `https://five.vaultnode.fr`, crée ton compte avec le code d'invitation : tu deviens organisateur.
2. Profil → Organisation : vérifie le créneau (jeudi 20:00 par défaut), le lieu habituel et les autres lieux, les rappels.
3. Copie le lien d'invitation et envoie-le dans le groupe WhatsApp.
4. Dans Organisation → Joueurs, règle le niveau de chacun (1 à 10, 5 = niveau moyen du groupe).

### Installer sur les téléphones

- **iPhone (Safari)** : Partager > Sur l'écran d'accueil (indispensable pour les notifications).
- **Android (Chrome)** : menu ⋮ > Installer l'application.

## Mise à jour

1. Un push sur `main` déclenche GitHub Actions, qui teste puis publie la nouvelle image.
2. **NAS** : une tâche planifiée vérifie l'image chaque nuit et redéploie l'app seulement si elle a changé.
3. **Téléphones** : les fichiers de l'app se mettent à jour en arrière-plan et la nouvelle version s'affiche à l'ouverture suivante.

La base est migrée automatiquement au démarrage, les données sont conservées.

### Tâche planifiée TrueNAS

**System > Advanced Settings > Cron Jobs > Add** :

- **Description** : Mise à jour Five du jeudi
- **Command** :

  ```sh
  img=ghcr.io/mikadvl/five-du-jeudi:latest; old=$(docker image inspect -f '{{.Id}}' $img 2>/dev/null); docker pull -q $img >/dev/null || exit 1; new=$(docker image inspect -f '{{.Id}}' $img); if [ "$old" != "$new" ]; then midclt call -j app.redeploy five; else echo "Five du jeudi deja a jour"; fi
  ```

- **Run As User** : root
- **Schedule** : tous les jours à 4h15

Pour une mise à jour immédiate, clique sur **Run Now** sur la tâche.

## Sauvegarde

Tout tient dans `/mnt/TANK_VAULT/APPS/FIVE/five.db` (SQLite). Une tâche de snapshot ZFS sur le dataset suffit. Ne supprime pas ce fichier : il contient aussi les clés des notifications push.

## Notifications

- **Android / ordinateur** : bouton « Activer les notifications » dans Profil (Chrome, Firefox, Edge).
- **iPhone** (iOS 16.4 ou plus) : il faut d'abord installer l'app (Safari → Partager → *Sur l'écran d'accueil*), l'ouvrir depuis l'icône, puis activer les notifications dans Profil. L'app affiche ces instructions si besoin.
- Bouton « M'envoyer un test » pour vérifier.
- **Email** (facultatif) : renseigne les variables `SMTP_*`. Chaque joueur qui a mis son email reçoit alors aussi les rappels et peut les couper dans son profil.

Les clés VAPID du Web Push sont générées au premier démarrage et stockées dans la base : ne supprime pas `five.db`, sinon les abonnements existants deviennent invalides.

## Comment sont faites les équipes

1. Chaque joueur a un **niveau** (1 à 10). Il le déclare à l'inscription, puis ce sont **les autres joueurs qui le notent** (Profil → Noter les joueurs, notes anonymes) : dès 3 notes reçues, son niveau devient la moyenne arrondie de ces notes. Niveau 5 = 1000 points, chaque point de niveau vaut 60 points.
2. Après chaque score saisi, un **Elo** est mis à jour : l'équipe qui gagne prend des points, d'autant plus si elle était donnée perdante et si l'écart est large.
3. La **force** utilisée pour équilibrer mélange les deux : au début c'est le niveau qui compte, puis l'historique prend le relais (jusqu'à 70 % au bout de 10 matchs). Un +1 compte pour son niveau estimé.
4. L'algo teste **toutes** les répartitions possibles (462 pour 12 joueurs) et garde celles où l'écart de force est minimal, en pénalisant les binômes qui ont déjà joué ensemble lors des 3 derniers matchs. Il tire au sort parmi les meilleures pour que les compos varient d'une semaine à l'autre.

Changer le niveau d'un joueur ou corriger un score recalcule tout l'historique. Les indices sont visibles uniquement par le joueur concerné et les organisateurs ; les autres ne voient que le pronostic global.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` | Dossier de la base SQLite |
| `APP_URL` | | URL publique (liens dans les emails) |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact pour le Web Push |
| `INVITE_CODE` | aléatoire | Code d'invitation initial |
| `TRUST_PROXY` | `1` | `0` si pas de reverse proxy |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | | Rappels par email |

## Structure

```
src/
  server.js    routes API + démarrage + planificateur (toutes les minutes)
  service.js   logique métier : inscriptions, liste d'attente, équipes, Elo, stats, rappels
  teams.js     niveau, Elo, algorithme de répartition
  notify.js    Web Push + email
  db.js        schéma SQLite, migrations, réglages
  auth.js      mots de passe (scrypt), sessions, limiteur anti brute-force
  time.js      dates et fuseau horaire (changements d'heure gérés)
public/        front PWA en JS natif, sans build (index.html, js/app.js, css/app.css, sw.js)
scripts/       seed-demo.js
test/          tests (node --test)
```
