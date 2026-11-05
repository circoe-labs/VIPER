# Renouveler le secret d'un jeton bearer sans changer d'identité

D'après la décision 2, `McpToken` reste l'identité de l'agent. Or régénérer un jeton bearer collé à la main crée
aujourd'hui une nouvelle identité. Il faudrait une action « renouveler le secret » qui remplace `token_hash` et
conserve l'`id`.
