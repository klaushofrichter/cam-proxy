import http from 'http';
import { envelope, field, faultSubcode, notifications } from './soap';

export interface OnvifMessage {
  topic: string; // e.g. tns1:RuleEngine/MyRuleDetector/PeopleDetect
  op: 'Initialized' | 'Changed' | 'Deleted';
  utc: number; // ms
  state: boolean; // IsMotion / State
}

class OnvifError extends Error {}
// The subscription no longer exists (camera rebooted, powered off, expired,
// unsubscribed): subscribe again.
export class OnvifGoneError extends OnvifError {}
// The camera refused the credentials. Messages never contain them.
export class OnvifAuthError extends OnvifError {}

const TEV = 'http://www.onvif.org/ver10/events/wsdl';
const WSNT = 'http://docs.oasis-open.org/wsn/b-2';
const EVENT_SERVICE = '/onvif/event_service';

// One ONVIF PullPoint subscription on the camera's event service.
export class OnvifSubscription {
  private manager: string | undefined; // path and query of the subscription manager
  private terminatesAt = 0; // on our clock

  constructor(
    private readonly t: { host: string; port: number; user: string; password: string },
    private readonly opts: { subscribeMin: number; pullTimeoutS: number; now?: () => number },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  terminationTime(): number {
    return this.terminatesAt;
  }

  // Renew when less than a third of the lifetime is left.
  needsRenew(): boolean {
    return this.terminatesAt - this.now() < (this.opts.subscribeMin * 60_000) / 3;
  }

  subscribed(): boolean {
    return this.manager !== undefined;
  }

  async subscribe(): Promise<void> {
    // A subscription we still hold is ended first (the camera allows few).
    if (this.manager) await this.unsubscribe().catch(() => undefined);
    this.manager = undefined;
    const xml = await this.call(EVENT_SERVICE, `${TEV}/EventPortType/CreatePullPointSubscriptionRequest`,
      `<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT${this.opts.subscribeMin}M</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`, false);
    const address = field(xml, 'Address');
    if (!address) throw new OnvifError('no subscription address in the reply');
    // Keep the path and query; the host is ours (the camera may answer with
    // an address that isn't reachable from here, e.g. behind port mapping).
    let path: string;
    try {
      const u = new URL(address);
      path = `${u.pathname}${u.search}`;
    } catch {
      throw new OnvifError('invalid subscription address in the reply');
    }
    this.manager = path;
    this.setTermination(xml);
  }

  async pull(signal?: AbortSignal): Promise<OnvifMessage[]> {
    const xml = await this.call(this.managerPath(), `${TEV}/PullPointSubscription/PullMessagesRequest`,
      `<tev:PullMessages><tev:Timeout>PT${this.opts.pullTimeoutS}S</tev:Timeout><tev:MessageLimit>100</tev:MessageLimit></tev:PullMessages>`, true, (this.opts.pullTimeoutS + 10) * 1000, signal);
    return notifications(xml)
      .filter((n) => n.topic && (n.op === 'Initialized' || n.op === 'Changed' || n.op === 'Deleted'))
      .map((n) => ({ topic: n.topic, op: n.op as OnvifMessage['op'], utc: Date.parse(n.utc) || this.now(), state: n.value === 'true' }));
  }

  async renew(): Promise<void> {
    const xml = await this.call(this.managerPath(), `${WSNT}/SubscriptionManager/RenewRequest`,
      `<wsnt:Renew><wsnt:TerminationTime>PT${this.opts.subscribeMin}M</wsnt:TerminationTime></wsnt:Renew>`, true);
    this.setTermination(xml);
  }

  async unsubscribe(): Promise<void> {
    if (!this.manager) return;
    try {
      await this.call(this.managerPath(), `${WSNT}/SubscriptionManager/UnsubscribeRequest`, '<wsnt:Unsubscribe/>', true);
    } finally {
      this.manager = undefined;
    }
  }

  private managerPath(): string {
    if (!this.manager) throw new OnvifGoneError('not subscribed');
    return this.manager;
  }

  private setTermination(xml: string): void {
    const term = Date.parse(field(xml, 'TerminationTime') ?? '');
    const cur = Date.parse(field(xml, 'CurrentTime') ?? '');
    // Camera-relative lifetime, placed on our clock (the clocks may differ).
    const life = Number.isFinite(term) && Number.isFinite(cur) ? term - cur : this.opts.subscribeMin * 60_000;
    this.terminatesAt = this.now() + Math.max(0, life);
  }

  // One SOAP request. `onManager`: failures mean the subscription is gone.
  private call(path: string, action: string, body: string, onManager: boolean, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    const to = `http://${this.t.host}:${this.t.port}${path}`;
    const payload = envelope({ action, to, user: this.t.user, password: this.t.password, body });
    const gone = (why: string) => (onManager ? new OnvifGoneError(why) : new OnvifError(why));
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: this.t.host, port: this.t.port, path, method: 'POST', timeout: timeoutMs, signal, headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`, 'Content-Length': Buffer.byteLength(payload) } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 1024 * 1024) return void req.destroy(new Error('reply too large'));
            chunks.push(c);
          });
          res.on('end', () => {
            const xml = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 200) return resolve(xml);
            const sub = faultSubcode(xml) ?? '';
            if (/NotAuthorized/i.test(sub) || res.statusCode === 401) return reject(new OnvifAuthError('the camera refused the ONVIF credentials'));
            reject(gone(`ONVIF fault ${sub || `HTTP ${res.statusCode}`}`));
          });
          res.on('error', () => reject(gone('ONVIF reply interrupted')));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e: NodeJS.ErrnoException) => reject(gone(`ONVIF request failed (${e.code ?? e.message})`)));
      req.end(payload);
    });
  }
}
