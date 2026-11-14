# Code signing (publisher)

AFKLLM is MIT open source. We **do not** use self-signed certificates for public
installers — Windows will correctly treat those as untrusted on other machines.

## Local builds

```bash
npm run dist
npm run verify:installer
```

Local `npm run dist` is usually **unsigned**. That is fine for your own testing.
`verify:installer` reports Authenticode status and still smoke-tests silent
install / uninstall. To require a real signature:

```bash
npm run verify:installer -- -RequireSigned
```

## Public releases — SignPath Foundation (recommended for OSS)

[SignPath Foundation](https://signpath.org/) provides **free** Authenticode signing
for qualifying open-source projects. The certificate is issued to SignPath
Foundation; they attest that the binary was built from your public repository.
Private keys stay on their HSM (no USB token on your laptop).

### Eligibility (summary)

- OSI-approved license (AFKLLM: MIT) without commercial dual-licensing of the app
- Public source + free downloads (GitHub Releases)
- No malware / no proprietary closed components in the signed package
- Team MFA on GitHub (and SignPath after approval)
- Attribution once enabled, e.g.  
  *Free code signing provided by SignPath.io, certificate by SignPath Foundation*

Full terms: https://signpath.org/terms.html

### Steps

1. Apply at [signpath.org](https://signpath.org/) for project  
   `https://github.com/0xQ71/AFKLLM`
2. After approval, create a SignPath.org organization / project and a **signing policy**
3. Add GitHub Actions secrets (names from SignPath docs), typically:
   - `SIGNPATH_API_TOKEN`
   - organization / project / policy slugs as inputs
4. Wire signing into [`.github/workflows/release.yml`](../../.github/workflows/release.yml):
   - build **unsigned** with `electron-builder` (`CSC_IDENTITY_AUTO_DISCOVERY=false`)
   - upload `AFKLLM-*-x64-setup.exe` to SignPath
   - download the signed artifact
   - attach the signed file to the GitHub Release
5. Document publisher in the release notes and README attribution line
6. Run `npm run verify:installer -- -RequireSigned` on the signed artifact

Microsoft also documents SignPath as the OSS option:  
https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options

## Alternatives

| Option | Notes |
|--------|--------|
| **SignPath Foundation** | Free for OSS; publisher = SignPath Foundation |
| **Certum Open Source** | Free/low-cost open-source Authenticode (USB token / process varies) |
| **Paid OV/EV** (DigiCert, Sectigo, …) | Publisher = your legal name; paid |
| **Azure Trusted Signing** | Subscription; regional eligibility limits for public trust |

## electron-builder notes

- Do **not** commit `.pfx` files
- For CI unsigned packaging before SignPath: set `CSC_IDENTITY_AUTO_DISCOVERY=false`
- `win.signtoolOptions.publisherName` in `electron-builder.yml` is metadata; it does
  **not** create a signature by itself
