// template literal at char 378373..378506  body length 132  glsl-marker-hits 1
// context before: ") * logDepthBufFC * 0.5;\n#endif`,CD=`#if defined( USE_LOGDEPTHBUF )\n\tuniform float logDepthBufFC;\n\tvarying float vFragDepth;\n\tvarying float vIsPerspective;\n#endif`,PD=`#ifdef USE_LOGDEPTHBUF\n\tvarying float vFragDepth;\n\tvarying float vIsPerspective;\n#endif`,ID="
// context after : ",LD=`#ifdef USE_MAP\n\tvec4 sampledDiffuseColor = texture2D( map, vMapUv );\n\t#ifdef DECODE_VIDEO_TEXTURE\n\t\tsampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );\n\t#endif\n\tdiffuseColor *= sample"
// ======================================================================
#ifdef USE_LOGDEPTHBUF
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
#endif
