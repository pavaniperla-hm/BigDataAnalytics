all: corpusGetter codeStreamGenerator codeStreamConsumer cljDetector monitorTool

corpusGetter:
	cd CorpusGetter && docker build -t corpusgetter .

corpusGetterFull:
	cd CorpusGetter && docker build -t corpusgetter . --no-cache


codeStreamGenerator:
	cd CodeStreamGenerator && docker build -t csgenerator .

codeStreamConsumer:
	cd CodeStreamConsumer && docker build -t csconsumer .

cljDetector:
	cd cljdetector && docker build -t cljdetector .

monitorTool:
	cd MonitorTool && docker build -t monitortool .

clean:
	docker rmi --force corpusgetter csgenerator
