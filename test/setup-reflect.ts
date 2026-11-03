// cam-sim's selfsigned runs on our @peculiar/x509 3 (package.json overrides:
// one x509 per process, as both register in the same tsyringe container).
// x509 3 needs a Reflect polyfill before it loads, and a test may import
// cam-sim before anything of ours.
import 'reflect-metadata';
