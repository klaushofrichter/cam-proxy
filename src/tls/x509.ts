// The one entry to @peculiar/x509. Since 2.0 it no longer brings a Reflect
// polyfill (its tsyringe needs one at load time): reflect-metadata is loaded
// here, before the library, and Node's WebCrypto is set as its provider.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'crypto';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export { x509 };
