import express, { type Express, type Request, type Response } from 'express';

import { autocompleteFor } from '../../application/input-type.js';
import {
  type AuthPagePort,
  type PendingSecretPrompt,
} from '../../application/secret-request-service.js';
import { renderStyle, type ThemeTokens } from './themes.js';

export type HttpDependencies = Readonly<{
  auth: AuthPagePort;
  theme: ThemeTokens;
  serviceVersion: string;
}>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LOCK_ICON =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

/** Read a form field from a parsed urlencoded body, defaulting to ''. */
function readField(body: unknown, field: string): string {
  if (typeof body === 'object' && body !== null && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  }

  return '';
}

export function createHttpApp({ auth, theme, serviceVersion }: HttpDependencies): Express {
  const style = renderStyle(theme);

  /** Wrap inner card markup in the full HTML document with the theme CSS. */
  const page = (title: string, inner: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${style}</style></head>` +
    `<body><main class="card">${inner}</main></body></html>`;

  const messageCard = (title: string, heading: string, message: string): string =>
    page(
      title,
      `<div class="card-head">${LOCK_ICON}<span>Secure env</span></div>` +
        `<div class="card-body"><h1>${escapeHtml(heading)}</h1>` +
        `<p class="muted">${escapeHtml(message)}</p></div>`,
    );

  const invalidTokenPage = messageCard(
    'Secure env',
    'Link expired',
    'This link is invalid or has already been used. Trigger the action again from your MCP ' +
      'client to get a fresh link.',
  );

  const renderForm = (token: string, prompt: PendingSecretPrompt, error?: string): string => {
    const fields = prompt.fields
      .map((field) => {
        const name = escapeHtml(field.name);
        const hint =
          field.description === undefined
            ? ''
            : `<span class="hint">${escapeHtml(field.description)}</span>`;
        // Stable name/id per variable plus a real autocomplete token: this is
        // what lets the browser save the submitted value and propose it again
        // the next time this form is shown.
        return (
          `<label for="${name}">${name}${hint}</label>` +
          `<input id="${name}" name="${name}" type="${field.input}" required ` +
          `autocomplete="${escapeHtml(autocompleteFor(field.name, field.input))}">`
        );
      })
      .join('');

    const inner =
      `<div class="card-head">${LOCK_ICON}<span>Secure env</span></div>` +
      `<div class="card-body">` +
      `<h1>Environment values</h1>` +
      `<p class="muted">Server <strong>${escapeHtml(prompt.serverName)}</strong> needs the ` +
      `following values to start. They are kept encrypted in memory and never written to disk.</p>` +
      (error === undefined ? '' : `<p class="error">${escapeHtml(error)}</p>`) +
      `<form method="post" action="/auth">` +
      `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
      fields +
      `<button type="submit">Save and continue</button>` +
      `</form>` +
      `<p class="footnote">Tip: let your browser remember these values — it will offer them ` +
      `the next time this server asks.</p>` +
      `</div>`;

    return page(`Environment values · ${prompt.serverName}`, inner);
  };

  const app = express();

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({ status: 'ok', version: serviceVersion });
  });

  // Loopback HTTPS form. `GET` renders the fields only for a live, unused
  // token; `POST` stores the submitted values in the encrypted vault. The
  // values never reach the MCP client, the model, or disk.
  app.get('/auth', (request: Request, response: Response) => {
    const token = typeof request.query.token === 'string' ? request.query.token : '';
    const prompt = auth.describe(token);

    if (prompt === undefined) {
      response.status(400).type('html').send(invalidTokenPage);
      return;
    }

    response.status(200).type('html').send(renderForm(token, prompt));
  });

  app.post('/auth', (request: Request, response: Response) => {
    const body: unknown = request.body;
    const token = readField(body, 'token');
    const prompt = auth.describe(token);

    if (token === '' || prompt === undefined) {
      response.status(400).type('html').send(invalidTokenPage);
      return;
    }

    const values: Record<string, string> = {};
    for (const field of prompt.fields) {
      values[field.name] = readField(body, field.name);
    }

    if (!auth.submit(token, values)) {
      // The token stays valid on a partial submit; re-render with an error so
      // the operator can complete the missing fields.
      response
        .status(400)
        .type('html')
        .send(renderForm(token, prompt, 'All fields are required.'));
      return;
    }

    response
      .status(200)
      .type('html')
      .send(
        messageCard(
          'Values saved',
          'Values saved',
          'You can close this tab and return to your MCP client. Re-run the command if it ' +
            'reported the link as text.',
        ),
      );
  });

  return app;
}
