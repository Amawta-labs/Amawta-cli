import { getProjectDocs } from '@context'
import { debug as debugLogger } from '@utils/log/debugLogger'
import { logError } from '@utils/log'

class AmawtaContextManager {
  private static instance: AmawtaContextManager
  private projectDocsCache = ''
  private cacheInitialized = false
  private initPromise: Promise<void> | null = null

  static getInstance(): AmawtaContextManager {
    if (!AmawtaContextManager.instance) {
      AmawtaContextManager.instance = new AmawtaContextManager()
    }
    return AmawtaContextManager.instance
  }

  private async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      try {
        const projectDocs = await getProjectDocs()
        this.projectDocsCache = projectDocs || ''
        this.cacheInitialized = true
      } catch (error) {
        logError(error)
        debugLogger.warn('AMAWTA_CONTEXT_LOAD_FAILED', {
          error: error instanceof Error ? error.message : String(error),
        })
        this.projectDocsCache = ''
        this.cacheInitialized = true
      }
    })()

    return this.initPromise
  }

  public getAmawtaContext(): string {
    if (!this.cacheInitialized) {
      this.initialize().catch(error => {
        logError(error)
        debugLogger.warn('AMAWTA_CONTEXT_LOAD_FAILED', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return ''
    }
    return this.projectDocsCache
  }

  public async refreshCache(): Promise<void> {
    this.cacheInitialized = false
    this.initPromise = null
    await this.initialize()
  }
}

const amawtaContextManager = AmawtaContextManager.getInstance()

export const generateAmawtaContext = (): string => {
  return amawtaContextManager.getAmawtaContext()
}

export const refreshAmawtaContext = async (): Promise<void> => {
  await amawtaContextManager.refreshCache()
}

if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    refreshAmawtaContext().catch(() => {})
  }, 0)
}
