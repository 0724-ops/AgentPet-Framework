// lines 571..578   char-offsets 338838..339175
	#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE
		emissiveColor = sRGBTransferEOTF( emissiveColor );
	#endif
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,tD=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,nD="gl_FragColor = linearToOutputTexel( gl_FragColor );",iD=`vec4 LinearTransferOETF( in vec4 value ) {
	return value;
