# Target codec proof fixtures

These twelve small files are the one canonical input corpus for host, iOS and
Android codec provisioning proofs. `target-contract.json` fixes their order,
byte count, SHA-256 and exact expected case matrix. A target receipt is invalid
if the corpus, generator, runner source or contract changes.

Regeneration is an intentional contract update, never a build step:

```bash
bash tests/fixtures/codecs/generate.sh tests/fixtures/codecs/data
npx vitest run tests/unit/codec-target-proof-contract.test.ts
```

The generator requires FFmpeg 8.x. Review every new hash and decoded dimension
in `target-contract.json`; target proof builds package these committed bytes and
do not invoke the host encoder.
