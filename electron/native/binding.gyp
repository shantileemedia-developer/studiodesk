{
  "targets": [
    {
      "target_name": "pa_callback",
      "sources": [ "pa_callback.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../../node_modules/naudiodon/portaudio/include"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        [
          "OS==\"win\"", {
            "configurations": {
              "Release": {
                "msvs_settings": {
                  "VCCLCompilerTool": {
                    "ExceptionHandling": 1,
                    "RuntimeTypeInfo": "true"
                  }
                }
              }
            },
            "libraries": [
              "-l<(module_root_dir)/../../node_modules/naudiodon/portaudio/bin/portaudio_x64.lib"
            ],
            "copies": [
              {
                "destination": "<(PRODUCT_DIR)",
                "files": [
                  "../../node_modules/naudiodon/portaudio/bin/portaudio_x64.dll"
                ]
              }
            ]
          }
        ]
      ]
    }
  ]
}
