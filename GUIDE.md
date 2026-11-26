# Sésame v2.2 — guide de mise en ligne

## Nouveautés de la v2.2 (à faire si Sésame est déjà en ligne)

- **QR qui change toutes les 10 secondes** : une capture d'écran est refusée au bout d'environ 20 secondes (verdict orange « Capture refusée »). Le code à taper à la main passe à 12 caractères (ex. `K7QF-2MXP-0427`).
- **Mode démo** (`demo.html`) avec des profils fictifs, et un lien « Essayer la démo » sur l'écran d'accueil.

Mise à jour, dans cet ordre :
1. Supabase → **SQL Editor** → collez **tout** `supabase.sql` → **Run** (aucune donnée n'est effacée).
2. Remettez le dossier `site/` en ligne sur Netlify.

Les QR déjà générés avant la mise à jour reçoivent leur clé au prochain affichage : l'étudiant retape simplement son code personnel.

---

Nouveautés de la v2 :
- connexion des étudiants par un **code reçu sur leur adresse @essec.edu** ;
- **notice RGPD** et consentement, plus un bouton pour supprimer son compte ;
- un **espace sécurité** (admin) avec des statistiques, l'historique, un export CSV, la gestion des comptes et les réglages ;
- côté agent : **son** selon le verdict, **lampe torche**, **retour automatique** au scanner après « Autorisé » ;
- côté étudiant : un **code personnel à 6 chiffres**, choisi à l'inscription et demandé à chaque génération de QR (double vérification : mail de l'école + code) ;
- des **couleurs inspirées de l'ESSEC**.

Comptez environ 30 minutes la première fois.

---

## Étape 1 — Mettre à jour la base de données

1. Supabase → **SQL Editor** → requête vide (*Create a new snippet*).
2. Collez **tout** le contenu de `supabase.sql`, cliquez dans le texte pour que rien ne soit surligné, puis **Run**.
3. Résultat attendu : « Success. No rows returned ».

Vos étudiants, votre historique, votre limite de QR et votre PIN sont conservés.
Les étudiants déjà inscrits devront se reconnecter avec le code reçu par mail, accepter la notice RGPD, puis choisir leur code personnel.

## Étape 2 — Activer l'envoi des codes par mail (Supabase)

### 2a. Mettre le code dans le mail

Supabase → **Authentication** → **Emails** → **Templates**.
Dans les modèles **Magic Link** et **Confirm signup**, remplacez le contenu par :

- Sujet : `Votre code Sésame`
- Texte :

```html
<h2>Votre code de connexion Sésame</h2>
<p>Entrez ce code dans l'appli :</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Il est valable une heure. Si vous n'avez rien demandé, ignorez ce mail.</p>
```

Sans `{{ .Token }}`, le mail contient un lien au lieu d'un code, et l'appli ne peut pas l'utiliser.

### 2b. Brancher un vrai service d'envoi (obligatoire pour les tests)

⚠️ Sans configuration, Supabase envoie **2 mails par heure au maximum**, et **seulement aux membres de votre équipe Supabase**. Les autres étudiants verraient l'erreur « L'envoi des mails n'est pas encore configuré ».

Supabase → **Authentication** → **Emails** → **SMTP Settings** → activez **Enable custom SMTP**.

**Option la plus simple : un compte Gmail créé pour le projet** (par exemple `sesame.projet@gmail.com`)
1. Activez la validation en deux étapes sur ce compte Google.
2. Dans le compte Google : Sécurité → **Mots de passe des applications** → créez-en un.
3. Dans Supabase, remplissez les champs :
   - Sender email : l'adresse Gmail
   - Sender name : `Sésame`
   - Host : `smtp.gmail.com`
   - Port : `587`
   - Username : l'adresse Gmail
   - Password : le mot de passe d'application (16 lettres)

**Option pro : Brevo**, si vous avez un nom de domaine. Host `smtp-relay.brevo.com`, port `587`, identifiant Brevo, et une clé SMTP générée dans Brevo (Settings → SMTP & API). L'adresse d'envoi doit être sur un domaine vérifié dans Brevo.

### 2c. Relever la limite d'envoi

Supabase → **Authentication** → **Rate Limits** : passez *Rate limit for sending emails* de 30 à **100 par heure** pour les journées de test.

## Étape 3 — Remplir `config.js`

```js
SUPABASE_URL:  "https://votre-projet.supabase.co",   // Project Settings > API Keys
SUPABASE_KEY:  "sb_publishable_…",                     // clé publique uniquement
CONTACT_EMAIL: "sesame.projet@gmail.com",              // affiché dans la notice RGPD
```

## Étape 4 — Mettre en ligne (Netlify)

Netlify → votre projet → **Deploys** → glissez le dossier (ou le zip `sesame-netlify.zip` avec votre `config.js` rempli).

| Pour qui | Lien |
|---|---|
| Étudiants | `https://VOTRE-SITE.netlify.app` |
| Agents | `https://VOTRE-SITE.netlify.app/#agent` |
| Équipe sécurité | `https://VOTRE-SITE.netlify.app/admin.html` |

## Étape 5 — Sécuriser l'espace admin

1. Ouvrez `admin.html`. Le mot de passe par défaut est `sesame-admin-2026` et le PIN agent par défaut est `2580`.
2. Dans **Réglages**, changez-les tout de suite : ces valeurs par défaut sont visibles par tous dans ce dépôt public. Choisissez un mot de passe long et un PIN de 6 chiffres.

Après 6 erreurs de PIN ou de mot de passe en 15 minutes depuis la même connexion, l'accès est bloqué 15 minutes.

## Ce que l'équipe sécurité peut faire dans l'espace admin

- **Vue d'ensemble** : passages autorisés et refusés aujourd'hui et cette semaine, nombre d'inscrits, graphique des 14 derniers jours.
- **Historique** : recherche par nom ou B00, filtre par dates, **export CSV** (s'ouvre dans Excel).
- **Étudiants** : fiche avec photo et derniers scans. Actions possibles :
  - **Bloquer** le compte : ses QR sont refusés au scan.
  - **Remettre le compteur** de la semaine à zéro.
  - **Demander une nouvelle photo** : la photo est verrouillée par défaut.
  - **Réinitialiser le code personnel** : en cas d'oubli, l'étudiant en choisit un nouveau à sa prochaine connexion.
  - **Supprimer** le compte.
- **Réglages** : nombre de QR par semaine, PIN des agents, domaine mail autorisé (laisser vide pour tester avec n'importe quelle adresse), mot de passe admin.

## Couleurs et polices

L'ESSEC ne publie pas sa charte graphique. Les couleurs utilisées sont un bleu marine institutionnel et le bleu ESSEC `#1DA1E0` (source : Brandfetch). Les polices sont Archivo pour les titres et Public Sans pour le texte, toutes deux libres.
Pour appliquer la charte officielle (à demander à la direction de la communication), modifiez seulement les variables en haut de `style.css` : `--brand`, `--brand-2` et `--f-display`.
Le site garde la mention « prototype étudiant, non officiel » et n'utilise pas le logo de l'école.

## Scénario de démo pour le rendez-vous

1. **Étudiant** : adresse @essec.edu → code reçu par mail → profil, photo et code personnel → « Générer mon QR » → code personnel → QR.
2. **Agent** (`/#agent`) : PIN → caméra → **Autorisé** (son et vibration) → retour automatique au scanner.
3. Rescanner le même QR : **Déjà utilisé**, avec l'historique de la semaine.
4. **Admin** : montrer le graphique, chercher l'étudiant, le **bloquer**, rescanner un nouveau QR → **Compte bloqué**.
5. Exporter l'historique en CSV.

## Le code personnel : comment ça marche

- Il est choisi à l'inscription (6 chiffres). Les codes trop simples comme 123456 ou 111111 sont refusés.
- Il est **stocké chiffré** : personne ne peut le lire, pas même l'admin.
- Il est demandé à **chaque** génération ou réaffichage du QR. Le QR n'est jamais enregistré sur le téléphone, et il se masque si l'appli reste plus de 2 minutes en arrière-plan.
- Le QR change toutes les 10 secondes : il est signé avec une clé propre à chaque QR, envoyée seulement après le code personnel.
- 5 erreurs = génération bloquée 15 minutes.
- Il protège le compte, mais **c'est toujours l'agent qui vérifie la photo** : c'est le contrôle principal.

## RGPD : à savoir

- La notice explique quelles données sont collectées, pourquoi, qui les voit, où elles sont stockées et combien de temps elles sont gardées. Le consentement est obligatoire à l'inscription.
- Vous avez choisi de **conserver l'historique sans limite de durée**. La notice le dit honnêtement. Pour un vrai déploiement, la CNIL demande une durée de conservation définie : c'est un point à valider avec l'école.

## En cas de problème

| Symptôme | Solution |
|---|---|
| « L'envoi des mails n'est pas encore configuré » | Étape 2b : SMTP personnalisé. |
| Le mail contient un lien et pas de code | Étape 2a : ajoutez `{{ .Token }}` dans les deux modèles. |
| « Trop de demandes de code » | Attendez une minute (1 code par minute et par adresse), ou relevez la limite (étape 2c). |
| Le mail n'arrive pas | Regardez dans les courriers indésirables. Avec Gmail, vérifiez le mot de passe d'application. |
| « Cette adresse n'est pas autorisée » | Seules les adresses @essec.edu sont acceptées. Pour tester avec d'autres adresses, videz le domaine dans Admin → Réglages. |
| Le PIN ou le mot de passe ne marche plus | Trop d'essais : attendez 15 minutes. |
| Un étudiant a oublié son code personnel | Admin → Étudiants → sa fiche → « Réinitialiser le code personnel ». |
| « Trop de codes incorrects » côté étudiant | 5 erreurs : génération bloquée 15 minutes. L'admin peut aussi réinitialiser le code. |
| « Capture refusée » alors que l'étudiant montre bien son écran | L'heure du téléphone est très décalée, ou l'appli était en arrière-plan : il masque puis réaffiche son QR. |
| Mot de passe admin oublié | SQL Editor : `update settings set value = 'nouveau-mdp' where key = 'admin_password';` |
