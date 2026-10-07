# Test keys

`agent_a_test.public.pem` is committed on purpose. It is the key B configures as
trusted, so that fixtures can carry signatures B will accept.

The private half is derived from a **committed, public seed** — see the banner in
`derive-test-keys.ts`. It protects nothing. Do not copy this arrangement for a real
deployment: there, the keypair comes from a CSPRNG and the private half never enters
the repository.

`agent_a_test.private.pem` is written locally by `derive-test-keys.ts` and is ignored
by `.gitignore` in this directory.
