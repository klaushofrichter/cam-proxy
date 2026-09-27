import { createHash, randomBytes } from 'crypto';

// Minimal SOAP 1.2 for ONVIF: request envelopes with WS-UsernameToken
// (PasswordDigest), and a linear scanner for replies. Camera replies are
// untrusted input, so no backtracking regular expressions run over them.

const NS =
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" ' +
  'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa5="http://www.w3.org/2005/08/addressing"';
const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const B64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-soap-message-security-1.0#Base64Binary';

export const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

// PasswordDigest = base64(sha1(nonce + created + password)).
export function securityHeader(user: string, password: string, now = new Date()): string {
  const nonce = randomBytes(16);
  const created = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)])).digest('base64');
  return (
    `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}"><wsse:UsernameToken>` +
    `<wsse:Username>${esc(user)}</wsse:Username><wsse:Password Type="${DIGEST}">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${B64}">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created>` +
    `</wsse:UsernameToken></wsse:Security>`
  );
}

export function envelope(opts: { action: string; to: string; user: string; password: string; body: string }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Header>` +
    `<wsa5:Action>${esc(opts.action)}</wsa5:Action><wsa5:To s:mustUnderstand="1">${esc(opts.to)}</wsa5:To>` +
    `${securityHeader(opts.user, opts.password)}</s:Header><s:Body>${opts.body}</s:Body></s:Envelope>`
  );
}

interface Element {
  local: string; // name without prefix
  attrs: string; // raw attribute text of the start tag
  start: number; // index of '<'
  textStart: number; // index after '>'
  selfClosing: boolean;
}

const NAME = /[A-Za-z0-9_.-]/;

// Start tags in document order, skipping end tags, comments, PIs and CDATA.
export function* elements(xml: string, from = 0, to = xml.length): Generator<Element> {
  let i = from;
  for (;;) {
    const lt = xml.indexOf('<', i);
    if (lt < 0 || lt >= to) return;
    const next = xml[lt + 1];
    if (next === '/' || next === '?' || next === '!') {
      const close = xml.startsWith('<!--', lt) ? xml.indexOf('-->', lt + 4) : xml.startsWith('<![CDATA[', lt) ? xml.indexOf(']]>', lt + 9) : xml.indexOf('>', lt + 1);
      if (close < 0) return;
      i = close + 1;
      continue;
    }
    let j = lt + 1;
    while (j < xml.length && (NAME.test(xml[j]) || xml[j] === ':')) j++;
    const qname = xml.slice(lt + 1, j);
    const gt = xml.indexOf('>', j);
    if (!qname || gt < 0) return;
    const selfClosing = xml[gt - 1] === '/';
    yield { local: qname.slice(qname.lastIndexOf(':') + 1), attrs: xml.slice(j, selfClosing ? gt - 1 : gt), start: lt, textStart: gt + 1, selfClosing };
    i = gt + 1;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e];
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

export function textOf(xml: string, el: Element): string {
  if (el.selfClosing) return '';
  const end = xml.indexOf('<', el.textStart);
  return decode(xml.slice(el.textStart, end < 0 ? xml.length : end)).trim();
}

// The text of the first element with this local name, within [from, to).
export function field(xml: string, name: string, from = 0, to = xml.length): string | undefined {
  for (const el of elements(xml, from, to)) if (el.local === name) return textOf(xml, el);
  return undefined;
}

export function attr(attrs: string, name: string): string | undefined {
  for (const m of attrs.matchAll(/([A-Za-z0-9_.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (m[1].slice(m[1].lastIndexOf(':') + 1) === name) return decode(m[2] ?? m[3] ?? '');
  }
  return undefined;
}

// The fault subcode (e.g. "ter:InvalidArgVal"), if the reply is a SOAP fault.
export function faultSubcode(xml: string): string | undefined {
  let inSub = false;
  for (const el of elements(xml)) {
    if (el.local === 'Subcode') inSub = true;
    else if (inSub && el.local === 'Value') return textOf(xml, el);
  }
  return undefined;
}

export interface Notification { topic: string; op: string; utc: string; name: string; value: string }

// The NotificationMessages of a PullMessages reply.
export function notifications(xml: string): Notification[] {
  const starts: number[] = [];
  for (const el of elements(xml)) if (el.local === 'NotificationMessage') starts.push(el.start);
  return starts.map((from, i) => {
    const to = starts[i + 1] ?? xml.length;
    const n: Notification = { topic: '', op: '', utc: '', name: '', value: '' };
    let inData = false;
    for (const el of elements(xml, from, to)) {
      if (el.local === 'Topic') n.topic = textOf(xml, el);
      else if (el.local === 'Message' && attr(el.attrs, 'PropertyOperation') !== undefined) {
        n.op = attr(el.attrs, 'PropertyOperation') ?? '';
        n.utc = attr(el.attrs, 'UtcTime') ?? '';
      } else if (el.local === 'Data') inData = true;
      else if (inData && el.local === 'SimpleItem' && !n.name) {
        n.name = attr(el.attrs, 'Name') ?? '';
        n.value = attr(el.attrs, 'Value') ?? '';
      }
    }
    return n;
  });
}
