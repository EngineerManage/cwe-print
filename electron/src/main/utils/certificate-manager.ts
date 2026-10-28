import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { X509Certificate } from 'crypto'
import { generate } from 'selfsigned'
import { logger } from './logger'

const execFileAsync = promisify(execFile)

const CERT_DIR = 'certificates'
const CA_KEY_FILE = 'cwe-print-local-ca.key'
const CA_CERT_FILE = 'cwe-print-local-ca.crt'
const SERVER_KEY_FILE = 'cwe-print-localhost.key'
const SERVER_CERT_FILE = 'cwe-print-localhost.crt'
const METADATA_FILE = 'metadata.json'
const CA_COMMON_NAME = '卡挖易 CA'
const SERVER_COMMON_NAME = 'localhost'
const SERVER_RENEW_BEFORE_DAYS = 30

export interface LocalTlsCertificate {
  key: string
  cert: string
  caCert: string
  caFingerprint: string
  trusted: boolean
  trustError?: string
}

interface CertificateMetadata {
  caFingerprint?: string
  trusted?: boolean
  trustedAt?: string
  trustError?: string
  generatedAt?: string
}

class CertificateManager {
  private certDir = path.join(app.getPath('userData'), CERT_DIR)
  private caKeyPath = path.join(this.certDir, CA_KEY_FILE)
  private caCertPath = path.join(this.certDir, CA_CERT_FILE)
  private serverKeyPath = path.join(this.certDir, SERVER_KEY_FILE)
  private serverCertPath = path.join(this.certDir, SERVER_CERT_FILE)
  private metadataPath = path.join(this.certDir, METADATA_FILE)
  private cached: LocalTlsCertificate | null = null
  private initializationPromise: Promise<LocalTlsCertificate> | null = null
  private trustPromise: Promise<{ trusted: boolean; error?: string }> | null = null

  async ensureLocalTlsCertificate(): Promise<LocalTlsCertificate> {
    if (this.cached) return this.cached

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeLocalTlsCertificate()
    }

    const initializationPromise = this.initializationPromise
    try {
      return await initializationPromise
    } catch (err) {
      if (this.initializationPromise === initializationPromise) {
        this.initializationPromise = null
      }
      throw err
    }
  }

  private async initializeLocalTlsCertificate(): Promise<LocalTlsCertificate> {
    this.ensureCertDir()
    await this.ensureCertificateFiles()

    const caCert = fs.readFileSync(this.caCertPath, 'utf-8')
    const caFingerprint = this.getFingerprint(caCert)
    const metadata = this.readMetadata()
    let trusted = metadata.trusted === true && metadata.caFingerprint === caFingerprint
    let trustError = metadata.trustError

    if (!trusted) {
      // Windows displays a system confirmation for this operation. Reuse the
      // first attempt for the entire app session so concurrent service starts
      // cannot open multiple certificate dialogs.
      const trustResult = await this.trustCaCertificateOnce()
      trusted = trustResult.trusted
      trustError = trustResult.error
      this.writeMetadata({
        ...metadata,
        caFingerprint,
        trusted,
        trustError,
        trustedAt: trusted ? new Date().toISOString() : metadata.trustedAt
      })
    }

    this.cached = {
      key: fs.readFileSync(this.serverKeyPath, 'utf-8'),
      cert: `${fs.readFileSync(this.serverCertPath, 'utf-8')}\n${caCert}`,
      caCert,
      caFingerprint,
      trusted,
      trustError
    }

    return this.cached
  }

  private trustCaCertificateOnce(): Promise<{ trusted: boolean; error?: string }> {
    if (!this.trustPromise) {
      this.trustPromise = this.trustCaCertificate()
    }
    return this.trustPromise
  }

  private ensureCertDir(): void {
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true })
    }
  }

  private async ensureCertificateFiles(): Promise<void> {
    if (!this.hasValidCa()) {
      await this.generateCa()
      await this.generateServerCertificate()
      return
    }

    if (!this.hasValidServerCertificate()) {
      await this.generateServerCertificate()
    }
  }

  private hasValidCa(): boolean {
    if (!fs.existsSync(this.caKeyPath) || !fs.existsSync(this.caCertPath)) return false

    try {
      const caCert = new X509Certificate(fs.readFileSync(this.caCertPath, 'utf-8'))
      const commonName = caCert.subject
        .split(/\r?\n/)
        .find((attribute) => attribute.startsWith('CN='))

      return (
        commonName === `CN=${CA_COMMON_NAME}` &&
        caCert.ca &&
        this.daysUntil(caCert.validTo) > SERVER_RENEW_BEFORE_DAYS
      )
    } catch {
      return false
    }
  }

  private hasValidServerCertificate(): boolean {
    if (!fs.existsSync(this.serverKeyPath) || !fs.existsSync(this.serverCertPath)) return false

    try {
      const cert = new X509Certificate(fs.readFileSync(this.serverCertPath, 'utf-8'))
      const hasLocalhost = cert.subjectAltName?.includes('DNS:localhost') ?? false
      const hasLoopback = cert.subjectAltName?.includes('IP Address:127.0.0.1') ?? false
      return hasLocalhost && hasLoopback && this.daysUntil(cert.validTo) > SERVER_RENEW_BEFORE_DAYS
    } catch {
      return false
    }
  }

  private async generateCa(): Promise<void> {
    logger.info('正在生成本地 WSS 根证书', 'cert')
    const now = new Date()
    const notAfter = new Date(now)
    notAfter.setFullYear(now.getFullYear() + 10)

    const ca = await generate(
      [
        { name: 'commonName', value: CA_COMMON_NAME },
        { name: 'organizationName', value: 'CWE Print' }
      ],
      {
        algorithm: 'sha256',
        keySize: 2048,
        notBeforeDate: now,
        notAfterDate: notAfter,
        extensions: [
          { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
          { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
        ]
      }
    )

    this.writePrivateFile(this.caKeyPath, ca.private)
    fs.writeFileSync(this.caCertPath, ca.cert, 'utf-8')
    this.writeMetadata({
      caFingerprint: this.getFingerprint(ca.cert),
      trusted: false,
      generatedAt: new Date().toISOString()
    })
  }

  private async generateServerCertificate(): Promise<void> {
    logger.info('正在生成 localhost WSS 服务证书', 'cert')
    const now = new Date()
    const notAfter = new Date(now)
    notAfter.setDate(now.getDate() + 397)

    const caKey = fs.readFileSync(this.caKeyPath, 'utf-8')
    const caCert = fs.readFileSync(this.caCertPath, 'utf-8')
    const server = await generate(
      [
        { name: 'commonName', value: SERVER_COMMON_NAME },
        { name: 'organizationName', value: 'CWE Print' }
      ],
      {
        algorithm: 'sha256',
        keySize: 2048,
        notBeforeDate: now,
        notAfterDate: notAfter,
        ca: { key: caKey, cert: caCert },
        extensions: [
          { name: 'basicConstraints', cA: false, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
          { name: 'extKeyUsage', serverAuth: true },
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' },
              { type: 7, ip: '::1' }
            ]
          }
        ]
      }
    )

    this.writePrivateFile(this.serverKeyPath, server.private)
    fs.writeFileSync(this.serverCertPath, server.cert, 'utf-8')
  }

  private async trustCaCertificate(): Promise<{ trusted: boolean; error?: string }> {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('certutil.exe', ['-user', '-addstore', 'Root', this.caCertPath], {
          windowsHide: true
        })
        logger.info('本地 WSS 根证书已写入 Windows 当前用户根证书库', 'cert')
        return { trusted: true }
      }

      if (process.platform === 'darwin') {
        const loginKeychain = this.getLoginKeychainPath()
        await execFileAsync('security', [
          'add-trusted-cert',
          '-r',
          'trustRoot',
          '-p',
          'ssl',
          '-k',
          loginKeychain,
          this.caCertPath
        ])
        logger.info('本地 WSS 根证书已写入 macOS 登录钥匙串', 'cert')
        return { trusted: true }
      }

      return {
        trusted: false,
        error: '当前系统暂不支持自动写入浏览器信任库，请手动信任本地 WSS 根证书。'
      }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      const message = error.stderr || error.message
      if (/already exists|已存在/i.test(message)) {
        logger.info('本地 WSS 根证书已存在于系统信任库', 'cert')
        return { trusted: true }
      }

      logger.error(`本地 WSS 根证书写入信任库失败: ${message}`, 'cert')
      return { trusted: false, error: message }
    }
  }

  private getLoginKeychainPath(): string {
    const keychainDb = path.join(os.homedir(), 'Library/Keychains/login.keychain-db')
    if (fs.existsSync(keychainDb)) return keychainDb
    return path.join(os.homedir(), 'Library/Keychains/login.keychain')
  }

  private readMetadata(): CertificateMetadata {
    try {
      if (!fs.existsSync(this.metadataPath)) return {}
      return JSON.parse(fs.readFileSync(this.metadataPath, 'utf-8')) as CertificateMetadata
    } catch {
      return {}
    }
  }

  private writeMetadata(metadata: CertificateMetadata): void {
    fs.writeFileSync(this.metadataPath, JSON.stringify(metadata, null, 2), 'utf-8')
  }

  private writePrivateFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 })
  }

  private getFingerprint(certPem: string): string {
    return new X509Certificate(certPem).fingerprint256
  }

  private daysUntil(dateText: string): number {
    return (new Date(dateText).getTime() - Date.now()) / 86400000
  }
}

export const certificateManager = new CertificateManager()
