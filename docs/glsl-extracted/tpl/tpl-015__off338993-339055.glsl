// template literal at char 338993..339055  body length 61  glsl-marker-hits 1
// context before: "as );\n#endif`,eD=`#ifdef USE_EMISSIVEMAP\n\tvec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );\n\t#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE\n\t\temissiveColor = sRGBTransferEOTF( emissiveColor );\n\t#endif\n\ttotalEmissiveRadiance *= emissiveColor.rgb;\n#endif`,tD="
// context after : ",nD=\"gl_FragColor = linearToOutputTexel( gl_FragColor );\",iD=`vec4 LinearTransferOETF( in vec4 value ) {\n\treturn value;\n}\nvec4 sRGBTransferEOTF( in vec4 value ) {\n\treturn vec4( mix( pow( value.rgb * "
// ======================================================================
#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif
