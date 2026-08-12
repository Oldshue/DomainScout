import CryptoKit
import Darwin
import Foundation

private let maximumSecretBytes = 4096
private let maximumEnvelopeBytes = 32 * 1024
private let storageVersion = 1
private let derivationLabel = Data("DomainScout device credential v1".utf8)

private enum CredentialStoreError: Error, CustomStringConvertible {
  case usage
  case invalidField(String)
  case invalidSecret
  case secureEnclaveUnavailable
  case unsafeStorage(String)
  case missing
  case selfTestFailed

  var description: String {
    switch self {
    case .usage:
      return "usage: DomainScoutCredentialStore <get|set|delete|self-test> --service <service> --account <account>"
    case .invalidField(let name):
      return "invalid \(name)"
    case .invalidSecret:
      return "credential must contain 1...\(maximumSecretBytes) bytes"
    case .secureEnclaveUnavailable:
      return "Secure Enclave is unavailable"
    case .unsafeStorage(let reason):
      return "credential storage is unsafe: \(reason)"
    case .missing:
      return "credential is not configured"
    case .selfTestFailed:
      return "credential store self-test failed"
    }
  }
}

private struct Arguments {
  let operation: String
  let service: String
  let account: String
}

private struct Envelope: Codable {
  let version: Int
  let secureEnclaveKey: Data
  let ephemeralPublicKey: Data
  let salt: Data
  let sealedBox: Data
}

private func boundedField(_ raw: String?, name: String) throws -> String {
  guard let value = raw, !value.isEmpty, value.utf8.count <= 128 else {
    throw CredentialStoreError.invalidField(name)
  }
  for byte in value.utf8 where byte < 0x21 || byte > 0x7e {
    throw CredentialStoreError.invalidField(name)
  }
  return value
}

private func parseArguments() throws -> Arguments {
  let values = CommandLine.arguments
  guard values.count >= 2 else { throw CredentialStoreError.usage }
  let operation = values[1]
  guard ["get", "set", "delete", "self-test"].contains(operation) else {
    throw CredentialStoreError.usage
  }
  var service: String?
  var account: String?
  var index = 2
  while index < values.count {
    guard index + 1 < values.count else { throw CredentialStoreError.usage }
    switch values[index] {
    case "--service": service = values[index + 1]
    case "--account": account = values[index + 1]
    default: throw CredentialStoreError.usage
    }
    index += 2
  }
  return Arguments(
    operation: operation,
    service: try boundedField(service, name: "service"),
    account: try boundedField(account, name: "account")
  )
}

private func credentialRoot() throws -> URL {
  let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  let root = applicationSupport.appendingPathComponent("DomainScout/Credentials", isDirectory: true)
  let parent = root.deletingLastPathComponent()
  try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  var isDirectory: ObjCBool = false
  if !FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  } else if !isDirectory.boolValue {
    throw CredentialStoreError.unsafeStorage("credential directory path is not a directory")
  }
  let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  guard values.isDirectory == true, values.isSymbolicLink != true else {
    throw CredentialStoreError.unsafeStorage("credential directory must be a physical directory")
  }
  let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
  guard (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
    throw CredentialStoreError.unsafeStorage("credential directory owner mismatch")
  }
  guard chmod(root.path, 0o700) == 0 else {
    throw CredentialStoreError.unsafeStorage("credential directory permissions")
  }
  return root
}

private func credentialURL(service: String, account: String) throws -> URL {
  let identity = Data("\(service)\u{0}\(account)".utf8)
  let digest = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
  return try credentialRoot().appendingPathComponent("credential-\(digest).plist", isDirectory: false)
}

private func authenticatedData(service: String, account: String) -> Data {
  Data("DomainScoutCredentialStore\u{0}\(storageVersion)\u{0}\(service)\u{0}\(account)".utf8)
}

private func symmetricKey(
  privateKey: SecureEnclave.P256.KeyAgreement.PrivateKey,
  publicKey: P256.KeyAgreement.PublicKey,
  salt: Data
) throws -> SymmetricKey {
  let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
  return sharedSecret.hkdfDerivedSymmetricKey(
    using: SHA256.self,
    salt: salt,
    sharedInfo: derivationLabel,
    outputByteCount: 32
  )
}

private func encodeCredential(_ secret: Data, service: String, account: String) throws -> Data {
  guard SecureEnclave.isAvailable else { throw CredentialStoreError.secureEnclaveUnavailable }
  guard !secret.isEmpty, secret.count <= maximumSecretBytes else { throw CredentialStoreError.invalidSecret }
  let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey()
  let ephemeralKey = P256.KeyAgreement.PrivateKey()
  let salt = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
  let key = try symmetricKey(privateKey: enclaveKey, publicKey: ephemeralKey.publicKey, salt: salt)
  let sealed = try AES.GCM.seal(secret, using: key, authenticating: authenticatedData(service: service, account: account))
  guard let combined = sealed.combined else { throw CredentialStoreError.invalidSecret }
  return try PropertyListEncoder().encode(Envelope(
    version: storageVersion,
    secureEnclaveKey: enclaveKey.dataRepresentation,
    ephemeralPublicKey: ephemeralKey.publicKey.rawRepresentation,
    salt: salt,
    sealedBox: combined
  ))
}

private func decodeCredential(_ data: Data, service: String, account: String) throws -> Data {
  guard SecureEnclave.isAvailable else { throw CredentialStoreError.secureEnclaveUnavailable }
  guard !data.isEmpty, data.count <= maximumEnvelopeBytes else {
    throw CredentialStoreError.unsafeStorage("credential envelope size")
  }
  let envelope = try PropertyListDecoder().decode(Envelope.self, from: data)
  guard envelope.version == storageVersion, envelope.salt.count == 32 else {
    throw CredentialStoreError.unsafeStorage("credential envelope version")
  }
  let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: envelope.secureEnclaveKey)
  let ephemeralPublicKey = try P256.KeyAgreement.PublicKey(rawRepresentation: envelope.ephemeralPublicKey)
  let key = try symmetricKey(privateKey: enclaveKey, publicKey: ephemeralPublicKey, salt: envelope.salt)
  let sealed = try AES.GCM.SealedBox(combined: envelope.sealedBox)
  let secret = try AES.GCM.open(sealed, using: key, authenticating: authenticatedData(service: service, account: account))
  guard !secret.isEmpty, secret.count <= maximumSecretBytes else { throw CredentialStoreError.invalidSecret }
  return secret
}

private func readPhysicalFile(_ url: URL) throws -> Data {
  var metadata = stat()
  guard lstat(url.path, &metadata) == 0 else {
    if errno == ENOENT { throw CredentialStoreError.missing }
    throw CredentialStoreError.unsafeStorage("credential metadata")
  }
  guard (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_uid == getuid(), metadata.st_nlink == 1,
        (metadata.st_mode & 0o777) == 0o600, metadata.st_size > 0,
        metadata.st_size <= maximumEnvelopeBytes else {
    throw CredentialStoreError.unsafeStorage("credential file metadata")
  }
  let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
  guard descriptor >= 0 else { throw CredentialStoreError.unsafeStorage("credential open") }
  let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  let data = try handle.readToEnd() ?? Data()
  try handle.close()
  guard data.count == Int(metadata.st_size) else {
    throw CredentialStoreError.unsafeStorage("credential file changed while reading")
  }
  return data
}

private func atomicWrite(_ data: Data, to url: URL) throws {
  guard !data.isEmpty, data.count <= maximumEnvelopeBytes else {
    throw CredentialStoreError.unsafeStorage("credential envelope size")
  }
  let temporary = url.deletingLastPathComponent().appendingPathComponent(".credential-\(UUID().uuidString).tmp")
  let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  guard descriptor >= 0 else { throw CredentialStoreError.unsafeStorage("temporary credential creation") }
  do {
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    try handle.write(contentsOf: data)
    try handle.synchronize()
    try handle.close()
    guard chmod(temporary.path, 0o600) == 0, rename(temporary.path, url.path) == 0 else {
      throw CredentialStoreError.unsafeStorage("atomic credential replacement")
    }
  } catch {
    unlink(temporary.path)
    throw error
  }
}

private func storeCredential(_ data: Data, service: String, account: String) throws {
  try atomicWrite(try encodeCredential(data, service: service, account: account),
                  to: credentialURL(service: service, account: account))
}

private func readCredential(service: String, account: String) throws -> Data {
  try decodeCredential(try readPhysicalFile(credentialURL(service: service, account: account)),
                       service: service, account: account)
}

private func deleteCredential(service: String, account: String) throws {
  let url = try credentialURL(service: service, account: account)
  if unlink(url.path) != 0, errno != ENOENT {
    throw CredentialStoreError.unsafeStorage("credential deletion")
  }
}

private func readStandardInput() throws -> Data {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty, data.count <= maximumSecretBytes else { throw CredentialStoreError.invalidSecret }
  return data
}

private func runSelfTest(service: String, account: String) throws {
  let testService = "\(service).self-test.\(UUID().uuidString.lowercased())"
  let testAccount = "\(account).self-test"
  let secret = Data(UUID().uuidString.utf8)
  defer { try? deleteCredential(service: testService, account: testAccount) }
  try storeCredential(secret, service: testService, account: testAccount)
  guard try readCredential(service: testService, account: testAccount) == secret else {
    throw CredentialStoreError.selfTestFailed
  }
  try deleteCredential(service: testService, account: testAccount)
}

do {
  let arguments = try parseArguments()
  switch arguments.operation {
  case "get":
    FileHandle.standardOutput.write(try readCredential(service: arguments.service, account: arguments.account))
  case "set":
    try storeCredential(try readStandardInput(), service: arguments.service, account: arguments.account)
  case "delete":
    try deleteCredential(service: arguments.service, account: arguments.account)
  case "self-test":
    try runSelfTest(service: arguments.service, account: arguments.account)
  default:
    throw CredentialStoreError.usage
  }
} catch CredentialStoreError.missing {
  exit(2)
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
