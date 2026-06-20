import React from 'react';
import { Drawer } from 'vaul';
import { Button } from "@/components/ui/button"


export function AIAssistant() {
  const [isOpen, setIsOpen] = React.useState(false);
 
  return (
    <Drawer.Root dismissible={false} open={isOpen} onOpenChange={setIsOpen} direction="right">
      <Drawer.Trigger className="relative flex h-10 flex-shrink-0 items-center justify-center gap-2 overflow-hidden rounded-full bg-white px-4 text-sm font-medium shadow-sm transition-all hover:bg-[#FAFAFA] dark:bg-[#161615] dark:hover:bg-[#1A1A19] dark:text-white">
        Open Drawer
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content className="bg-gray-100 flex flex-col rounded-t-[10px] mt-24 h-fit fixed bottom-0 left-0 right-0 outline-none">
          <div className="p-4 bg-white rounded-t-[10px] flex-1">
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-gray-300 mb-8" />
            <div className="max-w-md mx-auto">
              <Drawer.Title className="font-medium mb-4 text-gray-900">A non-dismissible drawer.</Drawer.Title>
              <p className="text-gray-600 mb-2">For cases when your drawer has to be always visible.</p>
              <p className="text-gray-600 mb-2">
                Nothing will close it unless you make it controlled and close it programmatically.
              </p>
              <Button
                className="rounded-md mt-4 w-full bg-gray-900 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-gray-800 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-gray-600"
                onClick={() => setIsOpen(false)}
              >
                Close Drawer
              </Button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
