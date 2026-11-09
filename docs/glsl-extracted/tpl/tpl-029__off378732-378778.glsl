// template literal at char 378732..378778  body length 45  glsl-marker-hits 1
// context before: "trix( projectionMatrix ) );\n#endif`,LD=`#ifdef USE_MAP\n\tvec4 sampledDiffuseColor = texture2D( map, vMapUv );\n\t#ifdef DECODE_VIDEO_TEXTURE\n\t\tsampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );\n\t#endif\n\tdiffuseColor *= sampledDiffuseColor;\n#endif`,DD="
// context after : ",ND=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )\n\t#if defined( USE_POINTS_UV )\n\t\tvec2 uv = vUv;\n\t#else\n\t\tvec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;\n\t#endi"
// ======================================================================
#ifdef USE_MAP
	uniform sampler2D map;
#endif
