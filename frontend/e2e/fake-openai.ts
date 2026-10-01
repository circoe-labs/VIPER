// A local stand-in for the OpenAI Responses API (Contact port P6: no real call to OpenAI, ever). Started by
// playwright.config.ts as a web server; the E2E backend points `VIPER_OPENAI_BASE_URL` at it.
//
// - `POST /v1/responses` answers a completed response whose output text is the JSON `{subject, body}` a strict
//   structured output would give, built only from the prompt's own lines (the company name, the booking link and the
//   « consigne » when present), so a spec can check what reached the model;
// - an input holding `FAKE_AI_FAIL` answers 503 (the backend retries, then says `ai_upstream_error`);
// - `GET /requests` returns the bodies received so far (a spec checks that no e-mail address was sent);
// - `GET /health` is the readiness probe. Synthetic values only; the key is checked for presence, never printed.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const port = Number(process.env.VIPER_E2E_OPENAI_PORT ?? 8046)
const received: unknown[] = []

function send(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  response.end(text)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

// The value of the prompt line `- <label> : <value>` in the given section of the input.
function fact(input: string, section: string, label: string): string | null {
  const start = input.indexOf(`${section} :`)
  if (start < 0) return null
  const block = input.slice(start).split('\n\n')[0] ?? ''
  const line = block.split('\n').find((row) => row.startsWith(`- ${label} : `))
  return line ? line.slice(`- ${label} : `.length) : null
}

function draft(instructions: string, input: string) {
  const company = fact(input, 'Entreprise', 'Nom') ?? 'votre entreprise'
  const civility = fact(input, 'Prospect', 'Civilité')
  const lastName = fact(input, 'Prospect', 'Nom')
  const salutation =
    civility && lastName ? `Bonjour ${civility === 'Mme' ? 'Madame' : 'Monsieur'} ${lastName},` : 'Bonjour,'
  const booking = /recopié exactement : (\S+)\. /.exec(instructions)?.[1]
  const consigne = /Consigne de l’utilisateur pour cette version :\n([^\n]+)/.exec(input)?.[1]
  const paragraphs = [
    salutation,
    `Circoe intègre des agents d’intelligence artificielle dans les processus de ${company}.`,
    ...(consigne ? [`(Consigne appliquée : ${consigne})`] : []),
    booking ? `Un échange de vingt minutes ? Vous pouvez choisir un créneau ici : ${booking}` : 'Un échange de vingt minutes ?',
    'Bien cordialement,',
  ]
  return { subject: `Agents IA pour ${company}`, body: paragraphs.join('\n\n') }
}

async function answer(request: IncomingMessage): Promise<[number, unknown]> {
  if (request.method === 'GET' && request.url === '/health') return [200, { ok: true }]
  if (request.method === 'GET' && request.url === '/requests') return [200, received]
  if (request.method !== 'POST' || request.url !== '/v1/responses') return [404, { error: { type: 'not_found', code: null } }]
  if (!request.headers.authorization?.startsWith('Bearer ')) {
    return [401, { error: { type: 'invalid_request_error', code: 'invalid_api_key' } }]
  }
  const body = await readJson(request)
  received.push(body)
  const instructions = typeof body.instructions === 'string' ? body.instructions : ''
  const input = typeof body.input === 'string' ? body.input : ''
  if (input.includes('FAKE_AI_FAIL')) return [503, { error: { type: 'server_error', code: null } }]
  const text = JSON.stringify(draft(instructions, input))
  return [
    200,
    {
      id: `resp_fake_${String(received.length)}`,
      object: 'response',
      status: 'completed',
      model: typeof body.model === 'string' ? `${body.model}-snapshot` : 'fake',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    },
  ]
}

const server = createServer((request, response) => {
  answer(request).then(
    ([status, body]) => {
      send(response, status, body)
    },
    (error: unknown) => {
      // Visible in the Playwright output: a fake that fails must not look like a slow model.
      console.error('fake OpenAI failed:', error)
      send(response, 500, { error: { type: 'fake_failure', code: null } })
    },
  )
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake OpenAI listening on http://127.0.0.1:${String(port)}/v1`)
})
