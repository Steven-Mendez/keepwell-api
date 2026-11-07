# Apple root certificate

`AppleRootCA-G3.cer` (DER) anchors the verification of App Store transactions and server
notifications (`src/adapters/external/apple/app-store.ts`). Downloaded from
https://www.apple.com/certificateauthority/ and checked against Apple's published fingerprint:

```
SHA-256 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
Valid until 2039-04-30
```

`openssl x509 -inform der -in AppleRootCA-G3.cer -noout -fingerprint -sha256` prints it.
