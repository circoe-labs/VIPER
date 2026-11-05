# Organisations, rôles et connexion Infomaniak

## 1. Modèle

- `organizations` : une entreprise cliente de VIPER (`name` unique, `email_domain` facultatif et unique).
  CIRCOE a un identifiant fixe (`CIRCOE_ORGANIZATION_ID`, `01a00000-0000-7000-8000-00000000c1c0`) et le domaine
  `circoe.com`.
- **Propriété des données** : les tables racines portent `organization_id`, qui vaut CIRCOE par défaut dans la
  base elle-même (`OrganizationOwnedMixin`). Ces tables sont `companies`, `prospects`, `missions`,
  `import_batches`, `contact_sequences`, `cohorts`, `appointments`, `agent_threads`, `internal_referents` et
  `mcp_tokens`. Les lignes enfants appartiennent au propriétaire de leur parent. La migration 0023 a attribué
  toutes les données existantes à CIRCOE. Dans l'explorateur, la colonne est masquée (`OWNER_COLUMN`).
- `users` :
  - `organization_id` ;
  - `role` : `admin`, `manager` ou `member` ;
  - `is_superadmin` : l'admin de la plateforme. Un index unique partiel garantit qu'il n'y en a qu'un ;
  - `is_active` ;
  - `infomaniak_sub` : le compte Infomaniak lié ;
  - `last_login_at` ;
  - `password_hash`, désormais facultatif.

## 2. Connexion

- **« Se connecter avec Infomaniak »** utilise OpenID Connect, avec un code d'autorisation, PKCE S256 et
  `client_secret_post`.
  - `GET /api/auth/infomaniak` redirige vers `login.infomaniak.com/authorize`. Le `state` et le verifier PKCE
    partent dans le cookie `viper_infomaniak_flow`, qui est HttpOnly, limité au chemin `/api/auth/infomaniak`,
    en `SameSite=Lax` et valable 10 minutes.
  - `GET /api/auth/infomaniak/callback` vérifie que le `state` correspond au cookie, échange le code, puis lit
    `userinfo` (`sub`, `email`, `email_verified`, `name`). Il ouvre ensuite la session VIPER habituelle et
    redirige vers `/`.
  - En cas de refus, la redirection mène à `/login?erreur=<code>`. Les codes sont `domain`, `inactive`,
    `organization`, `unverified`, `mismatch`, `cancelled`, `expired`, `infomaniak` et `unavailable`.
- **Phase de développement** (`organizations.check_can_sign_in`) :
  - seules les adresses des domaines `VIPER_SIGNIN_EMAIL_DOMAINS` peuvent se connecter (par défaut `circoe.com`) ;
  - seuls les membres actifs de CIRCOE sont acceptés : les lectures ne sont pas encore filtrées par organisation,
    et ce refus est ce qui garde les données isolées.
- **Première connexion** d'une adresse inconnue : le compte est créé comme Membre de l'organisation qui porte ce
  domaine. Une adresse déjà enregistrée (ajoutée depuis « Organisation ») est liée à son `sub` Infomaniak.
- **Admin de la plateforme** : `VIPER_PLATFORM_ADMIN_EMAIL` (par défaut `e.debazelaire@circoe.com`) reçoit le rôle à
  sa connexion, tant que personne ne l'a.
- **Mot de passe** : le formulaire n'existe que tant qu'Infomaniak n'est pas configuré, c'est-à-dire pour le
  développement local. `VIPER_PASSWORD_LOGIN_ENABLED` force l'un ou l'autre comportement. `GET /api/auth/methods`
  indique à la page de connexion ce qu'elle doit proposer.
- **Configuration** : `VIPER_INFOMANIAK_CLIENT_ID` et `VIPER_INFOMANIAK_CLIENT_SECRET` sont à créer dans le Manager
  Infomaniak, avec l'URI de redirection `https://<domaine>/api/auth/infomaniak/callback`.
- **Désactivée pour le moment** : `VIPER_INFOMANIAK_LOGIN_ENABLED` vaut `false` par défaut, car l'URI de
  redirection n'est pas encore enregistrée chez Infomaniak. Tant qu'il n'est pas à `true`, Infomaniak est
  considéré comme non configuré, même si l'identifiant et le secret sont renseignés, et le formulaire de mot de
  passe reste affiché.

## 3. Droits (« Organisation », `/organisation`)

| Action | Admin plateforme | Admin | Manager | Membre |
| --- | --- | --- | --- | --- |
| Voir les membres de son organisation | ✓ (toutes) | ✓ | ✓ | ✓ |
| Créer ou renommer une organisation | ✓ | — | — | — |
| Ajouter un membre | tout rôle | tout rôle | Membre seulement | — |
| Changer un rôle | ✓ | ✓ | — | — |
| Désactiver ou réactiver | ✓ | ✓ | les Membres | — |
| Réinitialiser les données de prospection | ✓ | ✓ | — | — |

Ces règles s'appliquent à tous les rôles :

- personne ne modifie son propre compte ;
- seul l'admin de la plateforme peut modifier son compte, et il ne le peut pas lui-même ;
- une organisation garde au moins un admin actif (sinon 409).

Désactiver un compte révoque ses sessions.

Chaque réponse de l'API indique ce que la personne connectée peut faire (`can_edit`, `can_change_role`,
`assignable_roles`, `can_rename`, `can_create`). Le service revérifie chaque modification et renvoie 403
`forbidden` s'il la refuse.

Audit : `organization.created`, `organization.updated`, `organization.member_added`,
`organization.member_updated`. Ils sont faits comme les événements `auth.*` : les lignes de compte elles-mêmes ne
sont jamais journalisées.

## 4. Suite

- Filtrer les lectures et écritures par `organization_id` avant d'ouvrir la connexion à une autre organisation.
- Lever alors le refus `organization` et la restriction de domaine.
