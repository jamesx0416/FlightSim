import { LoadingManager } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { createMsftTextureDdsExtension } from './MSFTTextureDDSExtension'
import { MSFSDDSLoader } from './MSFSDDSLoader'

export function createMsfsGltfLoader(
  options: {
    readonly urlResolver?: (url: string) => string
    readonly decodeNormalSources?: boolean
  } = {}
): GLTFLoader {
  const loadingManager = new LoadingManager()
  loadingManager.addHandler(/\.dds$/iu, new MSFSDDSLoader(loadingManager))
  if (options.urlResolver != null) {
    loadingManager.setURLModifier(url => options.urlResolver!(url))
  }

  const loader = new GLTFLoader(loadingManager)
  loader.register(parser =>
    createMsftTextureDdsExtension(parser as never, {
      decodeNormalSources: options.decodeNormalSources
    })
  )

  return loader
}
