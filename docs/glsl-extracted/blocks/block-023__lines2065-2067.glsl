// lines 2065..2067   char-offsets 404094..404218
	uniform sampler2D specularMap;
#endif`,vN=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
