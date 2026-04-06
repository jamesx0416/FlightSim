import { LoadingManager } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { createMsftTextureDdsExtension } from './MSFTTextureDDSExtension'
import { MSFSDDSLoader } from './MSFSDDSLoader'

export function createMsfsGltfLoader(
  urlResolver?: (url: string) => string
): GLTFLoader {
  const loadingManager = new LoadingManager()
  loadingManager.addHandler(/\.dds$/iu, new MSFSDDSLoader(loadingManager))
  if (urlResolver != null) {
    loadingManager.setURLModifier(url => urlResolver(url))
  }

  const loader = new GLTFLoader(loadingManager)
  loader.register(parser => createMsftTextureDdsExtension(parser as never))

  return loader
}
