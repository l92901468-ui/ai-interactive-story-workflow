# Security policy

This portfolio repository is designed for synthetic, local-only demonstrations.

## Never commit

- API keys, access tokens, cookies, private certificates, or `.env` files
- company, client, employee, or user identifiers
- private prompts, production logs, analytics exports, or model transcripts
- real scripts, images, assets, backups, snapshots, or repository history
- generated files containing local absolute paths or machine identifiers

## Safe contribution checklist

1. Confirm every example is fictional and marked `metadata.synthetic=true`.
2. Search staged changes for tokens, emails, phone numbers, absolute paths, and organization names.
3. Run `npm run check` and `npm test`.
4. Review generated receipts before sharing; hashes are safe, but their surrounding metadata may not be.
5. If sensitive material is found, remove it from the working tree and Git history before any publication.

## Reporting

Do not open a public issue containing sensitive details. Contact the repository owner through a private channel and include only the minimum information needed to reproduce the problem.
