// template literal at char 404070..404132  body length 61  glsl-marker-hits 1
// context before: "4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;\n\t#endif\n#endif`,mN=`float specularStrength;\n#ifdef USE_SPECULARMAP\n\tvec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );\n\tspecularStrength = texelSpecular.r;\n#else\n\tspecularStrength = 1.0;\n#endif`,gN="
// context after : ",vN=`#if defined( TONE_MAPPING )\n\tgl_FragColor.rgb = toneMapping( gl_FragColor.rgb );\n#endif`,xN=`#ifndef saturate\n#define saturate( a ) clamp( a, 0.0, 1.0 )\n#endif\nuniform float toneMappingExposure;"
// ======================================================================
#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif
