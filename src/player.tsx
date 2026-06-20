import { Input } from "./components/ui/input"
import { Button } from "./components/ui/button"
import { AIAssistant } from "./ai-assistant"
export function Player() {
    return (
    <main className="flex flex-row h-full overflow-hidden w-full">
        <div className="w-full h-full bg-yellow-100 flex flex-col items-center justify-center">
            <h1 className="text-2xl font-bold mb-4">Player Component</h1>
            <div className="w-1/2">
                <Input placeholder="Type something..." />
            </div>
            <div className="flex">
                <Button className="mr-2">Play</Button>
                <Button>Pause</Button>
            </div>
        </div>
        <AIAssistant />
    </main>
    )
}