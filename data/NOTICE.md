# Schema.org data

localseo includes two files from Schema.org. They were downloaded on 27 September 2026.

`vocabulary.json` is a smaller version of the [Schema.org vocabulary](https://schema.org/version/latest/schemaorg-current-https.jsonld). It keeps term names, types, parent types, and rules about where fields can be used and what values they can hold. It leaves out the written descriptions.

Its `version` field stores the SHA-256 hash of the original file. This is a value used to identify that copy of the file.

`context.json` comes from the [Schema.org JSON-LD context](https://schema.org/docs/jsonldcontext.jsonld). It helps the tool read schema names in JSON-LD.

These files are based on work by Schema.org. They use the Creative Commons Attribution-ShareAlike 3.0 licence. Read the [Schema.org terms](https://schema.org/docs/terms.html) and the [licence](https://creativecommons.org/licenses/by-sa/3.0/). The MIT licence for localseo's code does not change the licence of these files.

The check rules are version `2026-09-27.4`. Google rules were checked against the Search Central pages linked in each profile. A scan uses the rules included with the installed package. New rules arrive in a new package release.
